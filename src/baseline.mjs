// driftmon · 基线层（滚动窗口聚合，可整体重建）
//
// 不变量（docs/DATA-MODEL.md）：
//   * 按 (端点, 通道) 聚合，**禁止跨端点混池**——不同端点的 T 向量本来就不同；
//   * 基线必须带 probeSetHash；探针组换版后旧基线标 stale，不删除；
//   * 基线可以重建，但重建本身要记录原因。

import { signatureOfBatch } from './signature.mjs'
import { median, quantile } from './signature.mjs'

const CHANNELS = ['T', 'L', 'G', 'C', 'S']

function channelStatsT (signatures) {
  const vectors = signatures.map((signature) => signature.channels.T?.vector).filter((vector) => Array.isArray(vector))
  if (vectors.length === 0) return null
  const serialized = vectors.map((vector) => JSON.stringify(vector))
  const counts = new Map()
  for (const key of serialized) counts.set(key, (counts.get(key) ?? 0) + 1)
  return {
    vectorSeen: [...new Set(serialized)].map((key) => JSON.parse(key)),
    distinctVectors: counts.size,
    samples: vectors.length,
  }
}

function channelStatsL (signatures) {
  const rows = signatures.map((signature) => signature.channels.L).filter((value) => value !== null)
  if (rows.length === 0) return null
  const jaccards = rows.map((row) => row.topKJaccardMedian).filter((value) => typeof value === 'number')
  const medians = rows.map((row) => row.logprobMedian).filter((value) => typeof value === 'number')
  const iqrs = rows.map((row) => row.logprobIqr).filter((value) => typeof value === 'number')
  return {
    samples: rows.length,
    topKJaccard: jaccards.length === 0 ? null : {
      p50: median(jaccards),
      p95: quantile(jaccards, 0.95),
      p99: quantile(jaccards, 0.99),
      distinct: new Set(jaccards.map((value) => value.toFixed(6))).size,
    },
    logprobMedian: median(medians),
    logprobIqr: median(iqrs),
  }
}

function channelStatsG (signatures) {
  const rows = signatures.map((signature) => signature.channels.G).filter((value) => value !== null && value.failRate !== null)
  if (rows.length === 0) return null
  const failRates = rows.map((row) => row.failRate)
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  const failures = rows.reduce((sum, row) => sum + row.fails.length, 0)
  return {
    samples: rows.length,
    tokens: total,
    failRate: total === 0 ? null : failures / total,
    p50: median(failRates),
    p95: quantile(failRates, 0.95),
    ci95: wilsonInterval(failures, total),
  }
}

function channelStatsC (signatures) {
  const rows = signatures.map((signature) => signature.channels.C).filter((value) => value !== null && value.hitRatio !== null && value.hitRatio !== undefined)
  if (rows.length === 0) return null
  const ratios = rows.map((row) => row.hitRatio)
  return { samples: rows.length, hitRatioMedian: median(ratios), hitRatioP05: quantile(ratios, 0.05) }
}

function channelStatsS (signatures) {
  const rows = signatures.map((signature) => signature.channels.S).filter((value) => value !== null)
  if (rows.length === 0) return null
  const ttft = rows.map((row) => row.ttftMedian).filter((value) => typeof value === 'number')
  return { samples: rows.length, ttftMedian: median(ttft), ttftP95: quantile(ttft, 0.95) }
}

/** Wilson 95% 置信区间（失败率用）。 */
export function wilsonInterval (successes, total, z = 1.96) {
  if (total === 0) return null
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))
  return [(centre - margin) / denominator, (centre + margin) / denominator]
}

/**
 * 用最近 windowBatches 条批次构建一个 (provider, model) 的基线。
 * @param {object} options
 * @param {Array<object>} options.batches - 原始层批次
 * @param {Array<object>} options.probes - 冻结探针组
 * @param {string} options.providerId
 * @param {string} options.model
 * @param {string} options.probeSetHash
 * @param {number} [options.windowBatches]
 * @param {number} [options.baselineVersion]
 * @param {number} [options.now]
 * @param {string} [options.reason] - 重建原因（写进基线，便于回溯）
 */
export function buildBaseline (options) {
  const windowBatches = options.windowBatches ?? 30
  const relevant = (options.batches ?? [])
    .filter((batch) => batch.provider === options.providerId && batch.model === options.model)
    .filter((batch) => batch.probeSetHash === options.probeSetHash)
    .filter((batch) => batch.partial !== true)
    .filter((batch) => typeof batch.endpointId === 'string' && batch.endpointId.length > 0)
    .sort((a, b) => a.at - b.at)
  const window = relevant.slice(-windowBatches)
  if (window.length === 0) throw new Error(`没有可用于构建基线的批次：${options.providerId}/${options.model}`)

  const byEndpoint = new Map()
  for (const batch of window) {
    const list = byEndpoint.get(batch.endpointId) ?? []
    list.push(batch)
    byEndpoint.set(batch.endpointId, list)
  }
  const endpoints = {}
  for (const [endpointId, batches] of byEndpoint) {
    const signatures = batches.map((batch) => signatureOfBatch(batch, options.probes))
    endpoints[endpointId] = {
      endpointId,
      batches: batches.length,
      samples: batches.reduce((sum, batch) => sum + (batch.samples?.length ?? 0), 0),
      firstSeenAt: batches[0].at,
      lastSeenAt: batches[batches.length - 1].at,
      channels: {
        T: channelStatsT(signatures),
        L: channelStatsL(signatures),
        G: channelStatsG(signatures),
        C: channelStatsC(signatures),
        S: channelStatsS(signatures),
      },
    }
  }
  return {
    formatVersion: 1,
    baselineVersion: options.baselineVersion ?? 1,
    probeSetHash: options.probeSetHash,
    provider: options.providerId,
    model: options.model,
    generatedAt: options.now ?? Date.now(),
    reason: options.reason ?? 'rolling window rebuild',
    window: {
      batches: window.length,
      samples: window.reduce((sum, batch) => sum + (batch.samples?.length ?? 0), 0),
      from: window[0].at,
      to: window[window.length - 1].at,
    },
    endpoints,
  }
}

/** 探针组换版后的旧基线：标 stale，不删除（判分前必须先拒绝比较）。 */
export function markBaselineStale (baseline, currentProbeSetHash) {
  return { ...baseline, stale: baseline.probeSetHash !== currentProbeSetHash, staleReason: baseline.probeSetHash !== currentProbeSetHash ? 'probe-set-changed' : null }
}

export function channelNamesOf (baseline) {
  const names = new Set()
  for (const endpoint of Object.values(baseline.endpoints ?? {})) {
    for (const name of Object.keys(endpoint.channels ?? {})) {
      if (endpoint.channels[name] !== null) names.add(name)
    }
  }
  return [...names].sort((a, b) => CHANNELS.indexOf(a) - CHANNELS.indexOf(b))
}
