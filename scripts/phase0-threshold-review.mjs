#!/usr/bin/env node
// Phase 0 阈值 review 的只读回放工具（不写任何文件、不联网）。
//
// 用途：Phase 0 噪声底生成之后，把「判定阈值」从默认值换成噪声底推导值时，
// 用同一份原始层做「滚动基线回放」，看每个候选阈值会被多少批触发——避免拍脑袋。
//
// 口径（与 src/judge.mjs 对齐）：
//   L：单批 topKJaccardMedian 比基线 p50 低多少（drop）；
//   S：单批 ttftMedian / 基线 p95 的倍数；
//   G：单批失败率对基线失败率的二项检验 z 值；
//   C：单批命中率比基线 p50 低多少（drop）。
// 滚动基线 = 该批之前 config.baseline.windowBatches 批（与 judge 逐时刻的基线窗口同口径）；
// 前 W 批没有历史基线，跳过。结论只用于选阈值，不作为判定结论。
//
// 用法：
//   node scripts/phase0-threshold-review.mjs --config config.official-deepseek.example.json

import { pathsOf, readAllRawBatches, readJsonFile } from '../src/paths.mjs'
import { loadConfig } from '../src/config.mjs'
import { loadProbeSet } from '../src/probe-set.mjs'
import { signatureOfBatch, median, quantile } from '../src/signature.mjs'
import { buildNoiseFloor, noiseFloorSummary } from '../src/noise-floor.mjs'

function parseArgs (argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
    const next = argv[index + 1]
    if (inline !== undefined) flags[name] = inline
    else if (next !== undefined && !next.startsWith('--')) { flags[name] = next; index += 1 } else flags[name] = true
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
const { config, configPath } = await loadConfig({ configPath: flags.config })
const paths = pathsOf(config)
const { probeSet, probeSetHash } = await loadProbeSet(paths.probes)
const allBatches = await readAllRawBatches(paths)
const providerId = config.provider.id
const model = config.provider.model

const baselineFile = `${paths.baselines}/${providerId}--${model}.json`
const baseline = await readJsonFile(baselineFile, null)
const floor = buildNoiseFloor({
  batches: allBatches,
  probes: probeSet.probes,
  providerId,
  model,
  probeSetHash,
  rounds: Number(flags.rounds ?? 30),
  sessionsPerRound: config.collect.sessions,
  now: Date.now(),
})
const endpointId = floor.summary.endpointIds[0]
const baselineEndpoint = baseline?.endpoints?.[endpointId] ?? null
if (baseline === null) console.error(`缺少基线：${baselineFile}（先跑 driftmon baseline build；只影响基线展示行）`)
if (baselineEndpoint === null) console.error(`基线里没有端点 ${endpointId}`)

const comparable = allBatches
  .filter((batch) => batch.provider === providerId && batch.model === model)
  .filter((batch) => batch.partial !== true)
  .filter((batch) => batch.probeSetHash === probeSetHash)
  .filter((batch) => typeof batch.endpointId === 'string' && batch.endpointId.length > 0)
  .sort((a, b) => a.at - b.at)
const signatures = comparable.map((batch) => signatureOfBatch(batch, probeSet.probes))

const windowSize = Math.max(1, Number(config.baseline.windowBatches) || 30)
const rolling = []
for (let index = windowSize; index < signatures.length; index += 1) {
  const history = signatures.slice(index - windowSize, index)
  const current = signatures[index].channels
  const lHistory = history.map((signature) => signature.channels.L?.topKJaccardMedian).filter(Number.isFinite)
  const sHistory = history.map((signature) => signature.channels.S?.ttftMedian).filter(Number.isFinite)
  const gHistory = history.map((signature) => signature.channels.G).filter((value) => value !== null && value !== undefined && value.failRate !== null)
  const cHistory = history.map((signature) => signature.channels.C?.hitRatio).filter(Number.isFinite)
  const lP50 = lHistory.length === 0 ? null : median(lHistory)
  const sP95 = sHistory.length === 0 ? null : quantile(sHistory, 0.95)
  const gTokens = gHistory.reduce((sum, value) => sum + value.tokens, 0)
  const gFailures = gHistory.reduce((sum, value) => sum + value.fails.length, 0)
  const gP0 = gTokens === 0 ? null : gFailures / gTokens
  const cP50 = cHistory.length === 0 ? null : median(cHistory)
  const g = current.G
  rolling.push({
    at: comparable[index].at,
    Ldrop: current.L !== null && lP50 !== null ? lP50 - current.L.topKJaccardMedian : null,
    Sratio: current.S !== null && sP95 !== null && sP95 > 0 ? current.S.ttftMedian / sP95 : null,
    Gz: g !== null && g !== undefined && typeof g.failRate === 'number' && g.tokens > 0 && gP0 !== null
      ? (g.failRate - gP0) / Math.sqrt((gP0 * (1 - gP0)) / g.tokens + 1e-9)
      : null,
    Cdrop: current.C !== null && cP50 !== null && Number.isFinite(current.C.hitRatio) ? cP50 - current.C.hitRatio : null,
  })
}

const valuesOf = (key) => rolling.map((row) => row[key]).filter((value) => typeof value === 'number' && Number.isFinite(value))
const fmt = (value, digits = 3) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—')
const pct = (count, total) => (total === 0 ? '—' : `${((count / total) * 100).toFixed(1)}%`)

function summarize (values) {
  if (values.length === 0) return { n: 0 }
  return {
    n: values.length,
    min: Math.min(...values),
    p05: quantile(values, 0.05),
    p50: median(values),
    p95: quantile(values, 0.95),
    max: Math.max(...values),
  }
}

function thresholdTable (label, values, candidates, comparator) {
  const stats = summarize(values)
  console.log(`\n${label}（滚动回放 ${stats.n} 批；min=${fmt(stats.min)} p50=${fmt(stats.p50)} p95=${fmt(stats.p95)} max=${fmt(stats.max)}）`)
  const counts = candidates.map((candidate) => values.filter((value) => comparator(value, candidate)).length)
  console.log(`  候选阈值: ${candidates.map((value) => `≥${value}`).join(' | ')}`)
  console.log(`  触发批次: ${counts.map((count) => `${count}（${pct(count, values.length)}）`).join(' | ')}`)
  return counts
}

console.log('=== Phase 0 阈值 review 回放（只读） ===')
console.log(`配置：${configPath ?? '内置默认'} · 基线：${baselineFile}（v${baseline?.baselineVersion ?? '?'}，${baseline?.window?.batches ?? '?'} 批）`)
console.log('噪声底：')
for (const line of noiseFloorSummary(floor)) console.log(`  ${line}`)
console.log(`滚动回放：以「该批之前 ${windowSize} 批」为基线，回放 ${rolling.length} 批（跳过前 ${windowSize} 批；≈ judge 逐时刻行为）`)

const lValues = valuesOf('Ldrop')
const sValues = valuesOf('Sratio')
const gValues = valuesOf('Gz')
const cValues = valuesOf('Cdrop')
const lCounts = thresholdTable('L drop（基线 p50 − 批 topKJaccard）', lValues, [0.05, 0.06, 0.08, 0.10, 0.12, 0.15], (value, threshold) => value > threshold)
const sCounts = thresholdTable('S ratio（批 TTFT 中位 / 基线 p95）', sValues, [1.5, 1.8, 2.0, 2.5, 3.0], (value, threshold) => value > threshold)
thresholdTable('G z（批失败率 vs 基线，二项检验）', gValues, [1.5, 2, 2.5, 3], (value, threshold) => Math.abs(value) > threshold)
thresholdTable('C drop（基线 p50 − 批命中率）', cValues, [0.1, 0.15, 0.2, 0.25], (value, threshold) => value > threshold)

// 由噪声底 + 滚动回放推导建议阈值（取整规则写在这里，便于人工复核）。
const noiseL = floor.endpoints[endpointId]?.channels?.L?.topKJaccard ?? null
const noiseDrop = noiseL !== null && Number.isFinite(noiseL.p50) && Number.isFinite(noiseL.p05) ? noiseL.p50 - noiseL.p05 : null
const lFromNoise = noiseDrop === null ? null : Math.ceil(noiseDrop * 1.5 * 100) / 100
const lFromReplay = lValues.length === 0 ? null : Math.ceil(Math.max(...lValues) * 1.25 * 100) / 100
const lSuggested = lFromNoise === null && lFromReplay === null ? null : Math.max(lFromNoise ?? 0, lFromReplay ?? 0, 0.05)
const sMax = sValues.length === 0 ? null : Math.max(...sValues)
const sSuggested = sMax === null ? 1.5 : Math.max(1.5, Math.ceil(sMax * 2) / 2)
const lTriggers = lSuggested === null ? '—' : `${lValues.filter((value) => value > lSuggested).length}/${lValues.length}`
const sTriggers = sValues.filter((value) => value > sSuggested).length

console.log('\n=== 由噪声底推导的建议阈值（人工 review 用） ===')
console.log(`judge.lMaxTopKJaccardDrop：噪声底 p50−p05=${fmt(noiseDrop)} ×1.5 = ${lFromNoise ?? '—'}；滚动回放 max×1.25 = ${lFromReplay ?? '—'}（取较大）= ${lSuggested ?? '—'}`)
console.log(`  → 建议值回放触发：${lTriggers}（默认值 0.05 时 ${lCounts[0]}/${lValues.length}，即 ${pct(lCounts[0], lValues.length)}）`)
console.log(`judge.sTtftRatio：滚动回放 max=${fmt(sMax)} → 向上取 0.5 档 = ${sSuggested}`)
console.log(`  → 建议值回放触发：${sTriggers}/${sValues.length}（默认值 1.5 时 ${sCounts[0]}/${sValues.length}，即 ${pct(sCounts[0], sValues.length)}）`)
console.log(`judge.gZScore：噪声底失败率是常数（${fmt(baselineEndpoint?.channels?.G?.failRate)}），滚动回放 0 触发 → 保留默认 2（统计功效而非噪声决定）`)
console.log(`judge.cHitRatioDrop：噪声底命中率是常数（${fmt(baselineEndpoint?.channels?.C?.hitRatioMedian)}），滚动回放 0 触发 → 保留默认 0.2（缓存状态变化才触发）`)
console.log('gray.*：对比「窗口合并中位数」且已按模板区间留余量；噪声底未显示需要调整的证据时保留默认值。')
console.log('\n结论需要人工写进 src/config.mjs 的 DEFAULT_CONFIG 与 config.example.json，并记录依据（见 docs/PHASE0-PLAN.md §4）。')
