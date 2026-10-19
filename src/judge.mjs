// driftmon · 判定层
//
// 状态机（docs/DESIGN.md §5）固定五个取值，不允许出现「其他」：
//   insufficient / stable / route-change / drift-candidate / drift-confirmed
//
// 硬规则：
//   1. 先看窗口内样本量，不够一律 insufficient（这是合法结论，不是失败）；
//   2. 窗口内出现 ≥2 个端点 id → route-change（端点切换不能报成模型漂移）；
//   3. 跨端点差异不参与漂移判定，只在同一端点内部与自己的基线比；
//   4. 每条判定必须带 baselineVersion + probeSetHash + 时间窗 + 阈值。

import { signatureOfBatch } from './signature.mjs'

export const VERDICTS = ['insufficient', 'stable', 'route-change', 'drift-candidate', 'drift-confirmed']

/** 通道 → 独立来源分组：L 与 S 同源（都反映权重/部署），只算一条。 */
export const INDEPENDENT_SOURCE = { T: 'T', G: 'G', L: 'deploy', S: 'deploy', C: 'C' }

function endpointCounts (batches) {
  const counts = new Map()
  for (const batch of batches) {
    if (typeof batch.endpointId !== 'string') continue
    counts.set(batch.endpointId, (counts.get(batch.endpointId) ?? 0) + 1)
  }
  return counts
}

function signalsOfBatch (signature, baselineEndpoint, thresholds) {
  const signals = []
  const channels = signature.channels

  // T：token 计数向量必须逐项相等；不等就是配置/tokenizer 变化（唯一单次测量即确定的通道）。
  const tBaseline = baselineEndpoint?.channels?.T
  if (channels.T !== null && tBaseline !== null && Array.isArray(tBaseline?.vectorSeen)) {
    const currentVector = JSON.stringify(channels.T.vector)
    const seen = tBaseline.vectorSeen.some((vector) => JSON.stringify(vector) === currentVector)
    if (!seen) {
      signals.push({
        channel: 'T',
        source: INDEPENDENT_SOURCE.T,
        direction: 'changed',
        strong: true,
        detail: `T 向量 ${JSON.stringify(channels.T.vector)} 未在基线出现（基线见过 ${tBaseline.distinctVectors} 种）`,
      })
    }
  }

  // L：本批 top-k 重合度比基线 p50 掉太多 → 概率分布签名漂移。
  const lBaseline = baselineEndpoint?.channels?.L
  if (channels.L !== null && lBaseline !== null && typeof lBaseline?.topKJaccard?.p50 === 'number') {
    const current = channels.L.topKJaccardMedian
    if (typeof current === 'number') {
      const drop = lBaseline.topKJaccard.p50 - current
      if (drop > thresholds.lMaxTopKJaccardDrop) {
        signals.push({
          channel: 'L',
          source: INDEPENDENT_SOURCE.L,
          direction: 'down',
          detail: `top-k 重合度 ${current.toFixed(3)} 比基线 p50 ${lBaseline.topKJaccard.p50.toFixed(3)} 低 ${drop.toFixed(3)}`,
        })
      }
    }
    const currentMedian = channels.L.logprobMedian
    if (typeof currentMedian === 'number' && typeof lBaseline.logprobMedian === 'number' && typeof lBaseline.logprobIqr === 'number' && lBaseline.logprobIqr > 0) {
      const z = Math.abs(currentMedian - lBaseline.logprobMedian) / lBaseline.logprobIqr
      if (z > thresholds.lLogprobIqrZ) {
        signals.push({
          channel: 'L',
          source: INDEPENDENT_SOURCE.L,
          direction: currentMedian > lBaseline.logprobMedian ? 'up' : 'down',
          detail: `logprob 中位数偏移 ${z.toFixed(2)}×IQR（阈值 ${thresholds.lLogprobIqrZ}）`,
        })
      }
    }
  }

  // G：失败率二项检验（多轮合并成失败率，不看单次结果）。
  const gBaseline = baselineEndpoint?.channels?.G
  if (channels.G !== null && gBaseline !== null && typeof gBaseline?.failRate === 'number' && channels.G.tokens > 0) {
    const n = channels.G.tokens
    const p = channels.G.fails.length / n
    const p0 = gBaseline.failRate
    const standardError = Math.sqrt((p0 * (1 - p0)) / n + 1e-9)
    const z = (p - p0) / standardError
    if (Math.abs(z) > thresholds.gZScore) {
      signals.push({
        channel: 'G',
        source: INDEPENDENT_SOURCE.G,
        direction: z > 0 ? 'up' : 'down',
        detail: `glitch 失败率 ${p.toFixed(3)} vs 基线 ${p0.toFixed(3)}（z=${z.toFixed(2)}）`,
      })
    }
  }

  // C：第二次请求的缓存命中率掉了 → 后端被换/重启的强提示（易被正常过期误伤，故只算候选）。
  const cBaseline = baselineEndpoint?.channels?.C
  if (channels.C !== null && cBaseline !== null && typeof cBaseline?.hitRatioMedian === 'number') {
    const current = channels.C.hitRatio
    if (typeof current === 'number') {
      const drop = cBaseline.hitRatioMedian - current
      if (drop > thresholds.cHitRatioDrop) {
        signals.push({
          channel: 'C',
          source: INDEPENDENT_SOURCE.C,
          direction: 'down',
          detail: `cache 命中率 ${current.toFixed(3)} 比基线 ${cBaseline.hitRatioMedian.toFixed(3)} 低 ${drop.toFixed(3)}`,
        })
      }
    }
  }

  // S：TTFT 明显高于基线 p95 → 部署/硬件变化的弱信号。
  const sBaseline = baselineEndpoint?.channels?.S
  if (channels.S !== null && sBaseline !== null && typeof sBaseline?.ttftP95 === 'number' && sBaseline.ttftP95 > 0) {
    const current = channels.S.ttftMedian
    if (typeof current === 'number') {
      const ratio = current / sBaseline.ttftP95
      if (ratio > thresholds.sTtftRatio) {
        signals.push({
          channel: 'S',
          source: INDEPENDENT_SOURCE.S,
          direction: 'up',
          detail: `TTFT 中位数 ${current.toFixed(0)}ms 是基线 p95 的 ${ratio.toFixed(2)}×`,
        })
      }
    }
  }

  return signals
}

/** 合并同一独立来源的信号（L/S 同源只算一条）。 */
export function independentGroups (signals) {
  const groups = new Map()
  for (const signal of signals) {
    const existing = groups.get(signal.source)
    if (existing === undefined) groups.set(signal.source, { source: signal.source, channels: [signal.channel], directions: [signal.direction] })
    else {
      existing.channels.push(signal.channel)
      existing.directions.push(signal.direction)
    }
  }
  return [...groups.values()]
}

/** T 的 'changed' 没有方向语义：它和任何方向都算「同向复现」。 */
function consistentDirections (left, right) {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.has('changed') || rightSet.has('changed')) return true
  for (const direction of leftSet) if (rightSet.has(direction)) return true
  return false
}

function comparableBatches (batches, probeSetHash, provider, model) {
  return (batches ?? [])
    .filter((batch) => batch.provider === provider && batch.model === model)
    .filter((batch) => batch.partial !== true)
    .filter((batch) => typeof batch.endpointId === 'string' && batch.endpointId.length > 0)
    .filter((batch) => probeSetHash === undefined || batch.probeSetHash === probeSetHash)
    .sort((a, b) => a.at - b.at)
}

/**
 * 判定一个 (provider, model)。
 * @param {object} options
 * @param {Array<object>} options.batches - 全部原始批次
 * @param {Array<object>} options.probes - 冻结探针组
 * @param {object} options.baseline
 * @param {object} options.config - 完整配置（用 config.judge）
 * @param {string} [options.providerId]
 * @param {string} [options.model]
 */
export function judge (options) {
  const judgeConfig = options.config.judge
  const provider = options.providerId ?? options.config.provider.id
  const model = options.model ?? options.config.provider.model
  const all = comparableBatches(options.batches, options.baseline?.probeSetHash, provider, model)
  const window = all.slice(-judgeConfig.windowBatches)
  const thresholds = judgeConfig.thresholds
  const base = {
    provider,
    model,
    probeSetHash: options.baseline?.probeSetHash ?? null,
    baselineVersion: options.baseline?.baselineVersion ?? null,
    thresholds,
    window: {
      batches: window.length,
      samples: window.reduce((sum, batch) => sum + (batch.samples?.length ?? 0), 0),
      from: window[0]?.at ?? null,
      to: window[window.length - 1]?.at ?? null,
    },
  }

  // 1) 样本量不足：合法结论，不给方向。
  if (base.window.samples < judgeConfig.nMin) {
    return {
      ...base,
      verdict: 'insufficient',
      reason: 'not-enough-samples',
      detail: `窗口内 ${base.window.samples} 个样本 < N_min=${judgeConfig.nMin}`,
      endpointId: null,
      signals: [],
      independentGroups: [],
      channels: null,
    }
  }

  // 2) 窗口内出现多个端点 → 路由漂移，先分家，不进入模型漂移判定。
  const counts = endpointCounts(window)
  if (counts.size >= 2) {
    return {
      ...base,
      verdict: 'route-change',
      reason: 'multiple-endpoints-in-window',
      detail: `窗口内出现 ${counts.size} 个端点：${[...counts.entries()].map(([id, n]) => `${id}(${n})`).join('、')}`,
      endpoints: [...counts.entries()].map(([endpointId, batches]) => ({ endpointId, batches })),
      endpointId: null,
      signals: [],
      independentGroups: [],
      channels: null,
    }
  }

  const endpointId = [...counts.keys()][0]
  const baselineEndpoint = options.baseline?.endpoints?.[endpointId]
  if (baselineEndpoint === undefined) {
    return {
      ...base,
      verdict: 'insufficient',
      reason: 'no-baseline-for-endpoint',
      detail: `端点 ${endpointId} 还没有基线（先 baseline build）`,
      endpointId,
      signals: [],
      independentGroups: [],
      channels: null,
    }
  }

  // 3) 同一端点内部：本批签名 vs 该端点自己的基线。
  const latest = window[window.length - 1]
  const previous = window.length >= 2 ? window[window.length - 2] : null
  const latestSignature = signatureOfBatch(latest, options.probes)
  const latestSignals = signalsOfBatch(latestSignature, baselineEndpoint, thresholds)
  const latestGroups = independentGroups(latestSignals)
  const channels = {
    T: latestSignature.channels.T,
    L: latestSignature.channels.L,
    G: latestSignature.channels.G,
    C: latestSignature.channels.C,
    S: latestSignature.channels.S,
  }
  const baseResult = {
    ...base,
    endpointId,
    at: latest.at,
    signals: latestSignals,
    independentGroups: latestGroups.map((group) => group.source),
    channels,
  }

  if (latestSignals.length === 0) {
    return { ...baseResult, verdict: 'stable', reason: 'all-channels-within-noise', detail: `端点 ${endpointId} 的全部可用通道都在噪声内` }
  }

  // 4) 多通道同向 + 连续两次复现才允许升级为 confirmed。
  let confirmed = false
  let previousInfo = null
  if (previous !== null && latestGroups.length >= judgeConfig.minIndependentChannels) {
    const previousSignature = signatureOfBatch(previous, options.probes)
    const previousSignals = signalsOfBatch(previousSignature, baselineEndpoint, thresholds)
    const previousGroups = independentGroups(previousSignals)
    previousInfo = { at: previous.at, signals: previousSignals, independentGroups: previousGroups.map((group) => group.source) }
    const overlapping = latestGroups.filter((group) => previousGroups.some((prev) => prev.source === group.source))
    confirmed = overlapping.length >= judgeConfig.minIndependentChannels &&
      overlapping.every((group) => {
        const prev = previousGroups.find((candidate) => candidate.source === group.source)
        return prev !== undefined && consistentDirections(group.directions, prev.directions)
      })
  }

  if (confirmed) {
    return {
      ...baseResult,
      verdict: 'drift-confirmed',
      reason: 'multi-channel-shift-reproduced',
      detail: `${latestGroups.length} 个独立来源同向超阈值，且上一批复现：${latestGroups.map((group) => group.channels.join('/')).join('、')}`,
      previous: previousInfo,
    }
  }
  return {
    ...baseResult,
    verdict: 'drift-candidate',
    reason: 'channel-exceeded-noise',
    detail: latestGroups.length >= judgeConfig.minIndependentChannels
      ? `多通道超阈值但尚未连续复现（需 ${judgeConfig.confirmRounds} 批）`
      : `单通道超阈值（需至少 ${judgeConfig.minIndependentChannels} 个独立来源同向才升级）`,
    previous: previousInfo,
  }
}
