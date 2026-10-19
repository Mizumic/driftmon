// driftmon · 噪声底（Phase 0 标定的派生产物，离线可重算）
//
// 回答的问题：在「同一天 / 同端点 / 同模型」上连续跑 ≥30 轮完整探针组，
// 每个通道的自然波动有多大？哪些通道噪声太大、不足以支撑判定？
//
// 不变量（docs/DATA-MODEL.md）：
//   * 必须按端点分组，**禁止跨端点混池**（不同端点的 T 向量本来就不同）；
//   * 只吃「完整探针组 + 同一 probeSetHash + 非 partial」的批次；
//   * 只是派生统计，可随时从原始层重算，不参与主链判定。

import { median, quantile, signatureOfBatch } from './signature.mjs'
import { wilsonInterval } from './baseline.mjs'

export const NOISE_FLOOR_FORMAT_VERSION = 1
export const NOISE_FLOOR_KIND = 'noise-floor'

const CHANNELS = ['T', 'L', 'G', 'C', 'S']

/**
 * 通道可用性判定标准（Phase 0 的「口径」）。
 * 这些是**可解释的默认值**：Phase 0 标定完成后如要调整，改这里并写进 CHANGELOG。
 */
export const USABILITY_CRITERIA = {
  T: '同一端点内 T 向量唯一（distinctVectors === 1）',
  L: 'top-k Jaccard 的 p05 ≥ 0.60（多 token 的 top-k 结构足够稳定）',
  G: '失败率 95% CI 宽度 ≤ 0.20（样本量足够、失败率可估）',
  C: '缓存命中率 p50 ≥ 0.50（缓存通道有可观测信号）',
  S: 'TTFT 的 p95 / p50 ≤ 3.0（尾部不至于盖掉中位数）',
}

/** 数值分布摘要（忽略非有限值）。 */
export function distribution (values) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  return {
    samples: clean.length,
    min: clean[0],
    p05: quantile(clean, 0.05),
    p50: median(clean),
    p95: quantile(clean, 0.95),
    p99: quantile(clean, 0.99),
    max: clean[clean.length - 1],
    distinct: new Set(clean.map((value) => Number(value.toFixed(6)))).size,
  }
}

function channelNoiseT (signatures) {
  const vectors = signatures.map((signature) => signature.channels.T?.vector).filter((vector) => Array.isArray(vector))
  if (vectors.length === 0) return null
  const counts = new Map()
  for (const vector of vectors) {
    const key = JSON.stringify(vector)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const observed = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, batches]) => ({ vector: JSON.parse(key), batches }))
  const modeBatches = observed[0]?.batches ?? 0
  const distinct = counts.size
  return {
    samples: vectors.length,
    distinctVectors: distinct,
    vectorsObserved: observed,
    modeShare: vectors.length === 0 ? null : modeBatches / vectors.length,
    usable: distinct === 1,
    reason: distinct === 1 ? null : `同端点内出现 ${distinct} 种 T 向量（预期只有 1 种；检查探针组是否冻结、是否存在隐藏变量）`,
  }
}

function channelNoiseL (signatures) {
  const rows = signatures.map((signature) => signature.channels.L).filter((value) => value !== null)
  if (rows.length === 0) return null
  const topKJaccard = distribution(rows.map((row) => row.topKJaccardMedian))
  const logprobMedian = distribution(rows.map((row) => row.logprobMedian))
  const logprobIqr = distribution(rows.map((row) => row.logprobIqr))
  const distinctTokenSequences = distribution(rows.map((row) => row.distinctTokenSequences))
  const finiteLogprobs = rows.map((row) => row.logprobMedian).filter((value) => Number.isFinite(value))
  const probabilitiesDegenerate = finiteLogprobs.length > 0 && finiteLogprobs.every((value) => value === 0)
  const usable = topKJaccard !== null && topKJaccard.p05 !== null && topKJaccard.p05 >= 0.60
  return {
    samples: rows.length,
    topKJaccard,
    logprobMedian: logprobMedian === null ? null : logprobMedian.p50,
    logprobIqr: logprobIqr === null ? null : logprobIqr.p50,
    distinctTokenSequences,
    probabilitiesDegenerate,
    usable,
    reason: usable ? null : `top-k Jaccard p05=${topKJaccard?.p05?.toFixed(3) ?? '—'} < 0.60（多 token top-k 结构不稳定）`,
  }
}

function channelNoiseG (signatures) {
  const rows = signatures.map((signature) => signature.channels.G).filter((value) => value !== null && value.failRate !== null)
  if (rows.length === 0) return null
  const tokens = rows.reduce((sum, row) => sum + row.tokens, 0)
  const failures = rows.reduce((sum, row) => sum + row.fails.length, 0)
  const ci95 = wilsonInterval(failures, tokens)
  const ci95Width = ci95 === null ? null : ci95[1] - ci95[0]
  const usable = ci95Width !== null && ci95Width <= 0.20
  return {
    samples: rows.length,
    tokens,
    failures,
    failRate: tokens === 0 ? null : failures / tokens,
    failRateDistribution: distribution(rows.map((row) => row.failRate)),
    ci95,
    ci95Width,
    usable,
    reason: usable ? null : `失败率 95% CI 宽度=${ci95Width?.toFixed(3) ?? '—'} > 0.20（样本不足或失败率不可估）`,
  }
}

function channelNoiseC (signatures) {
  const rows = signatures.map((signature) => signature.channels.C).filter((value) => value !== null && Number.isFinite(value.hitRatio))
  if (rows.length === 0) return null
  const hitRatio = distribution(rows.map((row) => row.hitRatio))
  const usable = hitRatio !== null && hitRatio.p50 !== null && hitRatio.p50 >= 0.50
  return {
    samples: rows.length,
    hitRatio,
    usable,
    reason: usable ? null : `缓存命中率 p50=${hitRatio?.p50?.toFixed(3) ?? '—'} < 0.50（缓存通道没有可观测信号）`,
  }
}

function channelNoiseS (signatures) {
  const rows = signatures.map((signature) => signature.channels.S).filter((value) => value !== null)
  if (rows.length === 0) return null
  const ttft = distribution(rows.map((row) => row.ttftMedian))
  const ratio = ttft !== null && ttft.p50 > 0 ? ttft.p95 / ttft.p50 : null
  const usable = ratio !== null && ratio <= 3.0
  return {
    samples: rows.length,
    ttftMs: ttft,
    p95OverP50: ratio,
    usable,
    reason: usable ? null : `TTFT p95/p50=${ratio?.toFixed(2) ?? '—'} > 3.0（尾部波动过大）`,
  }
}

function channelStatsOf (signatures) {
  return {
    T: channelNoiseT(signatures),
    L: channelNoiseL(signatures),
    G: channelNoiseG(signatures),
    C: channelNoiseC(signatures),
    S: channelNoiseS(signatures),
  }
}

/**
 * 用原始层批次计算噪声底。
 * @param {object} options
 * @param {Array<object>} options.batches - 原始层批次（readAllRawBatches 的读视图）
 * @param {Array<object>} options.probes - 冻结探针组
 * @param {string} options.providerId
 * @param {string} options.model
 * @param {string} options.probeSetHash
 * @param {number} [options.rounds=30] - 取最近多少轮（一轮 = sessionsPerRound 个批次）
 * @param {number} [options.sessionsPerRound=8] - 一轮巡检的新会话数（= 批次数）
 * @param {number} [options.since] - 只取该时间戳（含）之后的批次（与 --since 对应）
 * @param {number} [options.now]
 */
export function buildNoiseFloor (options) {
  const rounds = options.rounds ?? 30
  const sessionsPerRound = options.sessionsPerRound ?? 8
  if (!Number.isInteger(rounds) || rounds <= 0) throw new Error(`rounds 需要正整数，收到 ${rounds}`)
  if (!Number.isInteger(sessionsPerRound) || sessionsPerRound <= 0) throw new Error(`sessionsPerRound 需要正整数，收到 ${sessionsPerRound}`)

  const skipped = { partial: 0, otherProviderModel: 0, otherProbeSet: 0, missingEndpoint: 0, beforeSince: 0 }
  const relevant = []
  for (const batch of options.batches ?? []) {
    if (batch.provider !== options.providerId || batch.model !== options.model) { skipped.otherProviderModel += 1; continue }
    if (batch.probeSetHash !== options.probeSetHash) { skipped.otherProbeSet += 1; continue }
    if (batch.partial === true) { skipped.partial += 1; continue }
    if (typeof batch.endpointId !== 'string' || batch.endpointId.length === 0) { skipped.missingEndpoint += 1; continue }
    if (options.since !== undefined && (batch.at ?? 0) < options.since) { skipped.beforeSince += 1; continue }
    relevant.push(batch)
  }
  relevant.sort((a, b) => a.at - b.at)
  const window = relevant.slice(-(rounds * sessionsPerRound))
  if (window.length === 0) {
    throw new Error(`没有可用于构建噪声底的批次：${options.providerId}/${options.model}（先按 docs/PHASE0-PLAN.md 跑 Phase 0 采集）`)
  }

  const byEndpoint = new Map()
  for (const batch of window) {
    const list = byEndpoint.get(batch.endpointId) ?? []
    list.push(batch)
    byEndpoint.set(batch.endpointId, list)
  }
  const endpoints = {}
  for (const [endpointId, batches] of byEndpoint) {
    batches.sort((a, b) => a.at - b.at)
    const signatures = batches.map((batch) => signatureOfBatch(batch, options.probes))
    const channels = channelStatsOf(signatures)
    const usableChannels = CHANNELS.filter((channel) => channels[channel]?.usable === true)
    const unusableChannels = {}
    const unavailableChannels = []
    for (const channel of CHANNELS) {
      const stats = channels[channel]
      if (stats === null) { unavailableChannels.push(channel); continue }
      if (stats.usable !== true) unusableChannels[channel] = stats.reason
    }
    endpoints[endpointId] = {
      endpointId,
      batches: batches.length,
      samples: batches.reduce((sum, batch) => sum + (batch.samples?.length ?? 0), 0),
      rounds: Number((batches.length / sessionsPerRound).toFixed(2)),
      from: batches[0].at,
      to: batches[batches.length - 1].at,
      channels,
      usableChannels,
      unusableChannels,
      unavailableChannels,
    }
  }

  const endpointIds = Object.keys(endpoints)
  const judgementUsable = CHANNELS.filter((channel) => endpointIds.every((endpointId) => endpoints[endpointId].channels[channel]?.usable === true))
  const windowBatches = window.length
  const windowRounds = Number((windowBatches / sessionsPerRound).toFixed(2))
  return {
    formatVersion: NOISE_FLOOR_FORMAT_VERSION,
    kind: NOISE_FLOOR_KIND,
    probeSetHash: options.probeSetHash,
    provider: options.providerId,
    model: options.model,
    generatedAt: options.now ?? Date.now(),
    sessionsPerRound,
    window: {
      rounds: windowRounds,
      batches: windowBatches,
      samples: window.reduce((sum, batch) => sum + (batch.samples?.length ?? 0), 0),
      from: window[0].at,
      to: window[window.length - 1].at,
      requestedRounds: rounds,
    },
    criteria: USABILITY_CRITERIA,
    endpoints,
    summary: {
      endpointCount: endpointIds.length,
      endpointIds,
      usableChannelsByEndpoint: Object.fromEntries(endpointIds.map((id) => [id, endpoints[id].usableChannels])),
      unusableChannelsByEndpoint: Object.fromEntries(endpointIds.map((id) => [id, endpoints[id].unusableChannels])),
      /** 所有端点都判定为「可用」的通道（跨端点判定时需要；T 只在端點内有效，见 caveats）。 */
      judgementUsable,
      verdict: windowRounds >= rounds ? 'calibrated' : 'insufficient-window',
      message: windowRounds >= rounds
        ? `窗口达到 ${rounds} 轮，可作为 Phase 0 噪声底`
        : `窗口只有 ${windowRounds} 轮（< ${rounds} 轮），Phase 0 尚未达标`,
    },
    skipped,
    caveats: [
      '不同端点的 T 向量本来就不同：T 只能按端点判断「是否变化」，不能跨端点比较数值。',
      'C（缓存命中）受前缀缓存状态影响，跨机器/跨时段不可直接比较。',
      'S（TTFT）是服务栈/负载信号，不是模型信号；它不可用不一定说明模型不可测。',
      '噪声底只是「自然波动范围」，不是漂移判定本身；阈值替换仍需要人工 review（见 docs/PHASE0-PLAN.md）。',
    ],
  }
}

/** 人可读摘要（CLI 输出用，返回字符串数组）。 */
export function noiseFloorSummary (floor) {
  const lines = []
  lines.push(`噪声底：${floor.provider}/${floor.model} · 窗口 ${floor.window.rounds} 轮 / ${floor.window.batches} 批 / ${floor.window.samples} 样本`)
  const pct = (value) => (typeof value === 'number' ? (value * 100).toFixed(1) + '%' : '—')
  const num = (value, digits = 3) => (typeof value === 'number' ? value.toFixed(digits) : '—')
  for (const [endpointId, endpoint] of Object.entries(floor.endpoints)) {
    const marks = CHANNELS.map((channel) => {
      if (endpoint.channels[channel] === null) return `${channel}—`
      return `${channel}${endpoint.channels[channel].usable === true ? '✅' : '❌'}`
    }).join(' ')
    lines.push(`  · ${endpointId}：${endpoint.batches} 批 / ${endpoint.samples} 样本（${endpoint.rounds} 轮）· ${marks}`)
    const t = endpoint.channels.T
    const l = endpoint.channels.L
    const g = endpoint.channels.G
    const c = endpoint.channels.C
    const s = endpoint.channels.S
    lines.push(`      明细：T ${t?.distinctVectors ?? '—'} 种向量` +
      ` · L p50/p05=${num(l?.topKJaccard?.p50)}/${num(l?.topKJaccard?.p05)}` +
      ` · G ${g?.failures ?? '—'}/${g?.tokens ?? '—'}（${pct(g?.failRate)}，CI ${g?.ci95 === null ? '—' : `[${num(g?.ci95?.[0])}, ${num(g?.ci95?.[1])}]`}）` +
      ` · C p50=${pct(c?.hitRatio?.p50)}` +
      ` · S p50/p95=${num(s?.ttftMs?.p50, 0)}/${num(s?.ttftMs?.p95, 0)}ms`)
    const problems = Object.entries(endpoint.unusableChannels)
    if (problems.length > 0) lines.push(`      不可用于判定：${problems.map(([channel, reason]) => `${channel}（${reason}）`).join('；')}`)
    if (endpoint.unavailableChannels.length > 0) lines.push(`      无数据：${endpoint.unavailableChannels.join(',')}`)
  }
  lines.push(`可用于判定的通道（所有端点一致）：${floor.summary.judgementUsable.join(',') || '无'}`)
  lines.push(`结论：${floor.summary.verdict} · ${floor.summary.message}`)
  return lines
}
