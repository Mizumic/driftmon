// driftmon · CLI
//
// 命令刻意保持少而直：
//   collect          一轮巡检（K 个新会话 × 冻结探针组）→ data/raw（append-only）
//   baseline build   滚动窗口聚合 → data/baselines（可重建）
//   judge run        同端点内部比基线 → results/alerts（可回溯）
//   report           把判定渲染成人可读报告 → results/reports
//   status           看一下配置、探针组、插件依赖、数据现状
//   probe-set hash   打印冻结探针组的哈希（改探针前先跑一下）
//   reference check  T 通道与官方 tokenizer 参考工件核对 → results/reference

import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig, pluginStorageDir } from './config.mjs'
import {
  alertFileFor,
  baselineFileFor,
  ensureDirs,
  noiseFloorFileFor,
  pathsOf,
  readAllRawBatches,
  readJsonFile,
  reportFileFor,
  templateFileFor,
  tokenizerCheckFileFor,
  tokenizerReferenceFileFor,
  watchFileFor,
  writeJsonAtomic,
} from './paths.mjs'
import { estimateTokens, filterProbes, loadProbeSet, summarizeProbeSet } from './probe-set.mjs'
import { loadPluginConfig, loadPluginDependency } from './plugin-dep.mjs'
import { collect } from './collect.mjs'
import { buildBaseline, channelNamesOf } from './baseline.mjs'
import { buildNoiseFloor, noiseFloorSummary } from './noise-floor.mjs'
import { judge } from './judge.mjs'
import { renderReport, writeReport } from './report.mjs'
import { buildCheckpointTemplate, templateSummary, validateTemplate } from './template.mjs'
import { buildWatchAlert, compareToTemplate } from './gray.mjs'
import {
  compareToTokenizerReference,
  tokenizerCheckIcon,
  tokenizerReferenceSummary,
  validateTokenizerReference,
} from './tokenizer-reference.mjs'

const VERSION = '0.1.0'

const HELP = `driftmon ${VERSION} · 后端漂移监测（设计文档见 driftmon/docs/）

用法：
  driftmon status
  driftmon probe-set hash
  driftmon collect [--sessions 8] [--only T,L] [--dry-run] [--provider P] [--model M]
  driftmon baseline build [--window 30] [--provider P] [--model M]
  driftmon baseline noise-floor [--rounds 30] [--since <时间>] [--provider P] [--model M]
  driftmon judge run [--provider P] [--model M] [--json]
  driftmon report [--provider P] [--model M]
  driftmon template build --fingerprint <32hex> [--name <检查点名>] [--since <时间>]
  driftmon template check [--template <file>] [--window <批数>]
  driftmon reference check [--window <批数>] [--reference <file>] [--json] [--no-write]

全局参数：
  --config <path>   配置文件（默认 driftmon/config.json，其次内置默认）
  --help            显示帮助

说明：
  * collect 会真的花钱（默认 K=8 × 冻结探针组 ≈ 46k token/轮），--dry-run 只打印第一个请求；
  * baseline noise-floor 汇总 Phase 0 标定窗口的自然波动（按端点/通道），写 data/baselines/noise-floor.json；
  * template build 用原始层里「指纹匹配」的完整批次固化某检查点的行为向量模板（不联网）；
  * template check 把最新窗口的批次对模板比较，写一份通用告警文件 results/watch/gray-watch.json；
  * reference check 用官方 tokenizer 参考工件（data/reference/official-tokenizer-v41.json）核对窗口内
    T 向量——参考值由 deepseek-recipe + 官方 v41 tokenizer 离线生成，不联网、不花 token，
    见 docs/TOKENIZER-REFERENCE.md；
  * 主动监测默认不随插件启动，需要显式跑这个 CLI（见 docs/DEPENDENCY.md 的分工）；
  * 从 dsh-system-fingerprint 只读 $DSH_HOME/storages/system-fingerprint/ 下的 endpoints.json（必需）
    与 config.json（可选，provider/检查点的只读导出）；不 import 插件代码。
`

function parseArgs (argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') { flags.help = true; continue }
    if (token.startsWith('--')) {
      const [rawName, inline] = token.slice(2).split('=')
      const name = rawName
      if (inline !== undefined) { flags[name] = inline; continue }
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[name] = next; index += 1 } else { flags[name] = true }
      continue
    }
    positional.push(token)
  }
  return { positional, flags }
}

function numberFlag (flags, name) {
  if (flags[name] === undefined) return undefined
  const value = Number(flags[name])
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} 需要正整数，收到 ${flags[name]}`)
  return value
}

function groupsFlag (flags) {
  if (flags.only === undefined) return undefined
  const text = String(flags.only)
  const groups = text.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  for (const group of groups) if (!['T', 'L', 'G', 'C', 'S'].includes(group)) throw new Error(`--only 里的组不合法：${group}`)
  return groups
}

async function contextOf (flags) {
  const overrides = { provider: {} }
  if (typeof flags.provider === 'string') overrides.provider.id = flags.provider
  if (typeof flags.model === 'string') overrides.provider.model = flags.model
  const { config, configPath } = await loadConfig({ configPath: flags.config, overrides })
  const paths = pathsOf(config)
  return { config, configPath, paths }
}

async function loadedProbes (paths) {
  return loadProbeSet(paths.probes)
}

async function commandStatus (flags) {
  const { config, configPath, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const summary = summarizeProbeSet(probeSet.probes)
  console.log(`driftmon ${VERSION}`)
  console.log(`配置：${configPath ?? '内置默认（无 config.json）'}`)
  console.log('')
  console.log(`探针组：version=${probeSet.probeSetVersion} · ${summary.probes} 条探针 / ${summary.requests} 请求`)
  console.log(`  hash=${probeSetHash}`)
  console.log(`  按组：${Object.entries(summary.byGroup).map(([group, row]) => `${group}=${row.probes}条/${row.requests}请求`).join(' · ')}`)

  const storageDir = pluginStorageDir(config)
  const dependency = await loadPluginDependency(storageDir)
  const exported = await loadPluginConfig(storageDir)
  console.log('')
  console.log('被动层依赖（dsh-system-fingerprint）：')
  if (dependency.found) {
    console.log(`  路径：${dependency.path}`)
    console.log(`  schema=v${dependency.version} · 端点 ${dependency.endpoints.length} 个 · 模型 ${dependency.models.size} 个 · 更新于 ${formatTime(dependency.updatedAt)}`)
    for (const warning of dependency.warnings) console.log(`  ⚠ ${warning}`)
  } else {
    console.log(`  不可用：${dependency.error}`)
    console.log('  说明：这只是被动观测缺失，driftmon 的主动探针仍可独立工作。')
  }
  if (exported.found) {
    const probe = exported.probe ?? {}
    const rawEnabled = exported.capture?.rawEnabled === true ? '开' : '关'
    console.log(`  只读配置 v${exported.version ?? '?'}：provider=${probe.provider ?? '—'} model=${probe.model ?? '—'} baseURL=${probe.openaiBaseURL ?? '—'} · 原始字节落盘=${rawEnabled}`)
    if (exported.checkpoint !== null) {
      const name = exported.checkpoint.name ?? '(映射表未收录)'
      console.log(`  当前检查点：${name} · ${exported.checkpoint.fingerprint} · 探测于 ${formatTime(exported.checkpoint.probedAt)}`)
    }
    for (const warning of exported.warnings) console.log(`  ⚠ ${warning}`)
  } else {
    console.log(`  只读配置：不可用（${exported.error}）`)
  }

  const batches = await readAllRawBatches(paths)
  const comparable = batches.filter((batch) => batch.partial !== true)
  const endpoints = new Set(comparable.map((batch) => batch.endpointId).filter(Boolean))
  console.log('')
  console.log(`原始层：${comparable.length} 批 / ${comparable.reduce((sum, batch) => sum + (batch.samples?.length ?? 0), 0)} 样本 · 端点 ${endpoints.size} 个${batches.length > comparable.length ? `（另有 ${batches.length - comparable.length} 批 partial，不参与判定）` : ''}`)
  const baseline = await readJsonFile(baselineFileFor(paths, config.provider.id, config.provider.model), null)
  if (baseline === null) {
    console.log('基线：无（先跑 driftmon baseline build）')
  } else {
    const stale = baseline.probeSetHash !== probeSetHash
    console.log(`基线：version ${baseline.baselineVersion} · ${baseline.window.batches} 批 / ${baseline.window.samples} 样本 · 端点 ${Object.keys(baseline.endpoints).length} 个${stale ? ' · ⚠ 探针组已换版，需要重建' : ''}`)
    console.log(`  通道：${channelNamesOf(baseline).join(', ') || '—'}`)
  }

  // 官方 tokenizer 参考（T 通道绝对参照；可选工件，缺失不影响其它命令）。
  const reference = await readJsonFile(tokenizerReferenceFileFor(paths), null)
  console.log('')
  console.log('官方 T 参照（deepseek-recipe + v41 tokenizer）：')
  if (reference === null) {
    console.log('  无工件（可选；生成方式见 docs/TOKENIZER-REFERENCE.md）')
  } else {
    const problems = validateTokenizerReference(reference, { probeSetHash, probes: probeSet.probes })
    for (const line of tokenizerReferenceSummary(reference)) console.log(`  ${line}`)
    if (problems.length > 0) {
      console.log(`  ⚠ 工件不可用：${problems[0]}`)
    } else {
      const lastCheck = await readJsonFile(tokenizerCheckFileFor(paths), null)
      const recent = lastCheck === null
        ? '未核对（跑 driftmon reference check）'
        : `${lastCheck.status} · ${lastCheck.provider ?? '?'}/${lastCheck.model ?? '?'} · ${formatTime(lastCheck.at)}`
      console.log(`  最近核对：${recent}`)
    }
  }
}

async function commandProbeSetHash (flags) {
  const { paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const summary = summarizeProbeSet(probeSet.probes)
  console.log(probeSetHash)
  if (flags.json === true) console.log(JSON.stringify({ probeSetVersion: probeSet.probeSetVersion, hash: probeSetHash, summary }, null, 2))
  else console.error(`version=${probeSet.probeSetVersion} · ${summary.probes} 条探针 / ${summary.requests} 请求`)
}

async function commandCollect (flags) {
  const { config, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const groups = groupsFlag(flags)
  const probes = probeSet.probes
  const selected = filterProbes(probes, groups)
  const sessions = numberFlag(flags, 'sessions') ?? config.collect.sessions
  const summary = summarizeProbeSet(selected)
  console.log(`一轮巡检：${sessions} 个新会话 × ${summary.probes} 条探针 = ${summary.requests * sessions} 个请求`)
  if (groups !== undefined) console.log(`⚠ 只跑 ${groups.join(',')} 组：批次会标 partial=true，不参与基线/判定（冒烟用）`)
  console.log(`provider=${config.provider.id} model=${config.provider.model} · 端点 ${config.provider.baseURL}`)
  const estimatedTokens = estimateTokens(selected) * sessions
  console.log(`预算口径：约 ${(estimatedTokens / 1000).toFixed(1)}k token（${sessions} 会话；含 C 组，按历史实测口径折算）`)
  const result = await collect({
    config,
    paths,
    probes,
    probeSetHash,
    probeSetVersion: probeSet.probeSetVersion,
    sessions,
    groups,
    dryRun: flags['dry-run'] === true,
    log: (line) => console.log(line),
  })
  if (result.dryRun === true) {
    console.log('')
    console.log('dry-run：不发请求。第一个请求：')
    console.log(`  ${result.firstRequest.method} ${result.firstRequest.url}`)
    console.log(`  headers：${Object.keys(result.firstRequest.headers).join(', ')}`)
    console.log(`  body：model=${result.firstRequest.body.model} max_tokens=${result.firstRequest.body.max_tokens} thinking=${JSON.stringify(result.firstRequest.body.thinking)}`)
    return
  }
  console.log('')
  console.log(`写入：${result.rawFile}`)
  console.log(`结果：${result.requests} 个请求 · ${result.samples} 个样本 · ${result.errors.length} 个错误 · endpoint=${result.endpointIds.join(',') || 'unknown'}`)
  console.log(`用量：prompt ${result.usage.promptTokens} · completion ${result.usage.completionTokens} · cached ${result.usage.cachedTokens} · 合计 ${result.usage.totalTokens} token`)
  if (result.errors.length > 0) {
    console.log('错误（前 5 条）：')
    for (const error of result.errors.slice(0, 5)) console.log(`  · ${error.probeId}: ${error.code} ${error.status ?? ''} ${String(error.message).slice(0, 160)}`)
  }
  if (result.partial) console.log('注意：这是 partial 批次，不进入基线/判定。')
  if (result.errors.length === result.requests) {
    throw new Error('全部请求失败；检查 key、baseURL、模型名与代理/网络')
  }
}

async function commandBaselineBuild (flags) {
  const { config, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const batches = await readAllRawBatches(paths)
  const window = numberFlag(flags, 'window') ?? config.baseline.windowBatches
  const file = baselineFileFor(paths, config.provider.id, config.provider.model)
  const previous = await readJsonFile(file, null)
  let baselineVersion = 1
  let reason = 'initial build'
  if (previous !== null) {
    baselineVersion = previous.probeSetHash === probeSetHash ? previous.baselineVersion + 1 : 1
    reason = previous.probeSetHash === probeSetHash ? 'rolling window rebuild' : 'probe-set changed, baseline restarted'
  }
  const baseline = buildBaseline({
    batches,
    probes: probeSet.probes,
    providerId: config.provider.id,
    model: config.provider.model,
    probeSetHash,
    windowBatches: window,
    baselineVersion,
    reason,
  })
  await ensureDirs(paths)
  await writeJsonAtomic(file, baseline)
  console.log(`基线已写入：${file}`)
  console.log(`version ${baseline.baselineVersion} · ${baseline.window.batches} 批 / ${baseline.window.samples} 样本 · 通道 ${channelNamesOf(baseline).join(',') || '—'}`)
  for (const [endpointId, endpoint] of Object.entries(baseline.endpoints)) {
    const channels = Object.entries(endpoint.channels).filter(([, value]) => value !== null).map(([key]) => key).join(',')
    console.log(`  · ${endpointId}：${endpoint.batches} 批 / ${endpoint.samples} 样本 · 通道 ${channels || '—'}`)
  }
}

async function commandNoiseFloor (flags) {
  const { config, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const batches = await readAllRawBatches(paths)
  const rounds = numberFlag(flags, 'rounds') ?? 30
  const sessionsPerRound = config.collect.sessions ?? 8
  const since = sinceFlag(flags)
  const floor = buildNoiseFloor({
    batches,
    probes: probeSet.probes,
    providerId: config.provider.id,
    model: config.provider.model,
    probeSetHash,
    rounds,
    sessionsPerRound,
    since,
  })
  const file = flags.out !== undefined ? resolve(String(flags.out)) : noiseFloorFileFor(paths)
  await ensureDirs(paths)
  await writeJsonAtomic(file, floor)
  console.log(`噪声底已写入：${file}`)
  for (const line of noiseFloorSummary(floor)) console.log(line)
  if (floor.summary.verdict !== 'calibrated') {
    console.log(`⚠ 窗口不足：${floor.summary.message}；Phase 0 验收标准见 docs/ROADMAP.md`)
  }
  console.log(`下一步：按 docs/PHASE0-PLAN.md 第 4 步做阈值 review（不要直接自动改 config）`)
}

async function loadBaselineOrThrow ({ config, paths }, probeSetHash) {  const file = baselineFileFor(paths, config.provider.id, config.provider.model)
  const baseline = await readJsonFile(file, null)
  if (baseline === null) throw new Error(`没有基线：${file}；先跑 driftmon baseline build`)
  if (baseline.probeSetHash !== probeSetHash) {
    throw new Error(`探针组已换版（基线 ${baseline.probeSetHash} ≠ 当前 ${probeSetHash}），拒绝比较；先重建基线`)
  }
  return baseline
}

async function commandJudge (flags) {
  const { config, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const baseline = await loadBaselineOrThrow({ config, paths }, probeSetHash)
  const batches = await readAllRawBatches(paths)
  const verdict = judge({ batches, probes: probeSet.probes, baseline, config })
  await ensureDirs(paths)
  const alertFile = alertFileFor(paths, verdict.at ?? Date.now(), config.provider.id, config.provider.model)
  await writeJsonAtomic(alertFile, verdict)
  if (flags.json === true) {
    console.log(JSON.stringify(verdict, null, 2))
    return
  }
  console.log(`${iconOf(verdict.verdict)} ${verdict.verdict} · ${verdict.provider}/${verdict.model}`)
  console.log(`  ${verdict.reason}：${verdict.detail}`)
  console.log(`  窗口：${verdict.window.batches} 批 / ${verdict.window.samples} 样本 · baseline v${verdict.baselineVersion}`)
  for (const signal of verdict.signals ?? []) console.log(`  · ${signal.channel}（${signal.source}）：${signal.detail}`)
  console.log(`已写入：${alertFile}`)
}

async function commandReport (flags) {
  const { config, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const baseline = await loadBaselineOrThrow({ config, paths }, probeSetHash)
  const batches = await readAllRawBatches(paths)
  const verdict = judge({ batches, probes: probeSet.probes, baseline, config })
  const dependency = await loadPluginDependency(pluginStorageDir(config))
  const content = renderReport({ verdict, dependency, baseline })
  const file = reportFileFor(paths, verdict.at ?? Date.now(), config.provider.id, config.provider.model)
  await writeReport(file, content)
  console.log(`报告已写入：${file}`)
  console.log(`判定：${verdict.verdict}（${verdict.reason}）`)
}

async function commandTemplateBuild (flags) {
  const { config, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const fingerprint = flags.fingerprint === undefined ? '' : String(flags.fingerprint).trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/u.test(fingerprint)) {
    throw new Error('template build 需要 --fingerprint <官方 system_fingerprint，32 位小写 hex>')
  }
  const batches = await readAllRawBatches(paths)
  const since = sinceFlag(flags)
  // 只取当前 provider/model 的批次：不同路由的同名模型不能混进一个模板。
  const scoped = batches.filter((batch) => batch.provider === config.provider.id && batch.model === config.provider.model && (since === undefined || (batch.at ?? 0) >= since))
  // 检查点名：--name 优先；否则查插件只读配置里的映射表（缺失就留空）。
  const exported = await loadPluginConfig(pluginStorageDir(config))
  const known = exported.found ? exported.checkpoints.find((entry) => entry.fingerprint === fingerprint) : undefined
  const name = typeof flags.name === 'string' ? flags.name : (known?.name ?? undefined)
  const template = buildCheckpointTemplate({
    batches: scoped,
    probes: probeSet.probes,
    probeSetHash,
    probeSetVersion: probeSet.probeSetVersion,
    checkpoint: { fingerprint, name },
    provider: { id: config.provider.id, baseURL: config.provider.baseURL, model: config.provider.model },
  })
  const problems = validateTemplate(template)
  if (problems.length > 0) throw new Error(`模板自检失败：${problems.join('；')}`)
  const file = templateFileFor(paths, template.checkpoint.name ?? fingerprint.slice(0, 12))
  await writeJsonAtomic(file, template)
  console.log(`模板已写入：${file}`)
  console.log(templateSummary(template))
  if (template.channels.L.available === true && template.channels.L.probabilitiesDegenerate === true) {
    console.log('注意：该端点 logprob 数值退化为 0，L 通道只用 top-k 集合做对比。')
  }
  if (template.window.batches < 2) console.log('注意：只有 1 个批次样本，建议至少 2 批（K≥8 会话一轮）再当参考。')
}

function sinceFlag (flags) {
  if (flags.since === undefined) return undefined
  const text = String(flags.since).trim()
  if (text === '') return undefined
  const numeric = Number(text)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) throw new Error(`--since 需要时间戳（毫秒）或可解析的日期，收到 ${text}`)
  return parsed
}

async function loadTemplateOrThrow (paths, flags, config) {
  if (flags.template !== undefined) {
    const file = resolve(String(flags.template))
    const template = await readJsonFile(file, null)
    if (template === null) throw new Error(`模板不存在：${file}`)
    const problems = validateTemplate(template)
    if (problems.length > 0) throw new Error(`模板自检失败：${problems.join('；')}`)
    return { template, file }
  }
  const dir = paths.templates
  let names = []
  try {
    names = (await readdir(dir)).filter((name) => /^checkpoint-.+\.json$/u.test(name))
  } catch {
    names = []
  }
  if (names.length === 0) throw new Error(`没有模板：先跑 driftmon template build（目录 ${dir}）`)
  const candidates = []
  for (const name of names) {
    const file = resolve(dir, name)
    try {
      const template = JSON.parse(await readFile(file, 'utf8'))
      if (validateTemplate(template).length > 0) continue
      const info = await stat(file)
      candidates.push({ template, file, mtime: info.mtimeMs })
    } catch {
      continue
    }
  }
  if (candidates.length === 0) throw new Error(`模板目录里没有可用模板（${dir}）`)
  // 优先与当前 provider/model 匹配的、最新修改的那份
  candidates.sort((left, right) => {
    const leftMatch = left.template.provider?.id === config.provider.id && left.template.provider?.model === config.provider.model ? 1 : 0
    const rightMatch = right.template.provider?.id === config.provider.id && right.template.provider?.model === config.provider.model ? 1 : 0
    if (leftMatch !== rightMatch) return rightMatch - leftMatch
    return right.mtime - left.mtime
  })
  return { template: candidates[0].template, file: candidates[0].file }
}

async function commandTemplateCheck (flags) {
  const { config, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const { template, file: templateFile } = await loadTemplateOrThrow(paths, flags, config)
  if (template.probeSet?.hash !== probeSetHash) {
    throw new Error('模板与当前探针组不一致（probeSetHash 不同）；换过探针组需要重采并 template build')
  }
  if (template.provider?.id !== config.provider.id || template.provider?.model !== config.provider.model) {
    throw new Error(`模板属于 ${template.provider?.id ?? '?'}/${template.provider?.model ?? '?'}，与当前配置 ${config.provider.id}/${config.provider.model} 不一致（用 --template 指定别的模板）`)
  }
  const batches = await readAllRawBatches(paths)
  const window = numberFlag(flags, 'window') ?? config.collect.sessions
  const compared = compareToTemplate({
    batches,
    probes: probeSet.probes,
    template,
    windowBatches: window,
    thresholds: config.gray?.thresholds,
  })
  const alert = buildWatchAlert(compared, { templateFile })
  await ensureDirs(paths)
  const outFile = flags.out !== undefined ? resolve(String(flags.out)) : watchFileFor(paths)
  await writeJsonAtomic(outFile, alert)
  const icon = { stable: '🟢', insufficient: '⚪', 'gray-candidate': '🟡', 'checkpoint-change': '🔴', 'config-change': '🟠', 'infra-change': '🔵' }[compared.verdict] ?? '·'
  console.log(`${icon} ${compared.verdict} · ${compared.subject.provider}/${compared.subject.model}`)
  console.log(`  ${compared.message}`)
  console.log(`  模板：${template.checkpoint?.name ?? '(未命名)'} · ${template.checkpoint?.fingerprint ?? '?'} · ${template.probeSet?.hash?.slice(0, 24) ?? '?'}…`)
  console.log(`  窗口：${compared.window.batches} 批 / ${compared.window.samples} 样本（最近 ${window} 批）`)
  for (const item of compared.signals) console.log(`  · ${item.channel}（${item.verdict}）：${item.detail}`)
  for (const caveat of compared.caveats) console.log(`  ⚠ ${caveat}`)
  // 可选：同一窗口对官方 tokenizer 参考工件再核对一次（没有工件/工件不合法就跳过，不影响模板判定）。
  try {
    const reference = await readJsonFile(tokenizerReferenceFileFor(paths), null)
    if (reference !== null && validateTokenizerReference(reference, { probeSetHash, probes: probeSet.probes }).length === 0) {
      const refCompared = compareToTokenizerReference({
        batches,
        probes: probeSet.probes,
        reference,
        provider: config.provider.id,
        model: config.provider.model,
        windowBatches: window,
      })
      console.log(`  官方 T 参照：${tokenizerCheckIcon(refCompared.status)} ${refCompared.status}（${refCompared.detail}）`)
    }
  } catch {
    // 参考工件是可选增强，读失败不影响模板核对
  }
  console.log(`已写入：${outFile}`)
}

/**
 * T 通道核验：把窗口内实测 T 向量与官方参考工件（deepseek-recipe + v41 tokenizer 离线生成）比对。
 * 不联网、不花 token；只回答「tokenizer / prompt 模板 / 请求渲染路径是否仍与官方参考一致」，
 * 不代表权重没变（权重相关的漂移看 judge / template check）。
 */
async function commandReferenceCheck (flags) {
  const { config, paths } = await contextOf(flags)
  const { probeSet, probeSetHash } = await loadedProbes(paths)
  const referenceFile = flags.reference === undefined ? tokenizerReferenceFileFor(paths) : resolve(String(flags.reference))
  const reference = await readJsonFile(referenceFile, null)
  if (reference === null) {
    throw new Error(`没有官方 tokenizer 参考工件：${referenceFile}；生成方式见 docs/TOKENIZER-REFERENCE.md`)
  }
  const problems = validateTokenizerReference(reference, { probeSetHash, probes: probeSet.probes })
  if (problems.length > 0) throw new Error(`参考工件自检失败：${problems.join('；')}`)
  const batches = await readAllRawBatches(paths)
  const window = numberFlag(flags, 'window') ?? config.collect.sessions
  const compared = compareToTokenizerReference({
    batches,
    probes: probeSet.probes,
    reference,
    provider: config.provider.id,
    model: config.provider.model,
    windowBatches: window,
  })
  const record = { ...compared, provider: config.provider.id, model: config.provider.model, referenceFile }
  const outFile = flags.out !== undefined ? resolve(String(flags.out)) : tokenizerCheckFileFor(paths)
  if (flags['no-write'] !== true) await writeJsonAtomic(outFile, record)

  if (flags.json === true) {
    console.log(JSON.stringify(record, null, 2))
    return
  }
  console.log(`${tokenizerCheckIcon(compared.status)} tokenizer-reference ${compared.status} · ${config.provider.id}/${config.provider.model}`)
  console.log(`  ${compared.detail}`)
  for (const line of tokenizerReferenceSummary(reference)) console.log(`  ${line}`)
  const range = compared.window.from === null ? '' : `（${formatTime(compared.window.from)} → ${formatTime(compared.window.to)}）`
  console.log(`  窗口：${compared.window.batches} 批${range}${compared.observed.skipped > 0 ? ` · 跳过 ${compared.observed.skipped} 批无 T 数据` : ''}`)
  if (compared.observed.vectors.length > 1) {
    console.log(`  观测到的 T 向量：${compared.observed.vectors.map((vector) => JSON.stringify(vector)).join(' / ')}`)
  }
  for (const diff of compared.diffs) console.log(`  · ${diff.probeId}：期望 ${diff.expected}，实测 ${diff.observed}`)
  if (flags['no-write'] !== true) console.log(`已写入：${outFile}`)
}

function iconOf (verdict) {
  return { insufficient: '⚪', stable: '🟢', 'route-change': '🔀', 'drift-candidate': '🟡', 'drift-confirmed': '🔴' }[verdict] ?? '·'
}

function formatTime (timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
  return new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, 'Z')
}

/**
 * CLI 入口。
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Promise<number>} exit code
 */
export async function main (argv) {
  const { positional, flags } = parseArgs(argv)
  if (flags.help === true || positional.length === 0) {
    console.log(HELP)
    return positional.length === 0 && flags.help !== true ? 1 : 0
  }
  const [command, subcommand] = positional
  try {
    if (command === 'status') return await commandStatus(flags).then(() => 0)
    if (command === 'probe-set') return await commandProbeSetHash(flags).then(() => 0)
    if (command === 'collect') return await commandCollect(flags).then(() => 0)
    if (command === 'baseline' && subcommand === 'build') return await commandBaselineBuild(flags).then(() => 0)
    if (command === 'baseline' && subcommand === 'noise-floor') return await commandNoiseFloor(flags).then(() => 0)
    if (command === 'judge' && (subcommand === 'run' || subcommand === undefined)) return await commandJudge(flags).then(() => 0)
    if (command === 'report') return await commandReport(flags).then(() => 0)
    if (command === 'template' && subcommand === 'build') return await commandTemplateBuild(flags).then(() => 0)
    if (command === 'template' && subcommand === 'check') return await commandTemplateCheck(flags).then(() => 0)
    if (command === 'reference' && subcommand === 'check') return await commandReferenceCheck(flags).then(() => 0)
    console.error(`未知命令：${positional.join(' ')}\n`)
    console.log(HELP)
    return 1
  } catch (error) {
    console.error(`driftmon: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}
