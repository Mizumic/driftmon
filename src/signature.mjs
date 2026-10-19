// driftmon · 签名层（纯函数，可重算）
//
// 一次巡检（一个会话 = 一个 batch）→ 一条数值签名。不读基线、不联网、不解释。
// 签名只依赖「原始层 + 冻结的探针组」；探针组顺序参与 T 向量的定义。

import { createHash } from 'node:crypto'

export function sha256Of (value) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

export function median (values) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  const mid = Math.floor(clean.length / 2)
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2
}

export function quantile (values, q) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  if (clean.length === 1) return clean[0]
  const position = (clean.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return clean[lower]
  return clean[lower] + (clean[upper] - clean[lower]) * (position - lower)
}

export function jaccard (left, right) {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/** 一组签名里每个通道的可用性（缺数据不是 0，是「不可用」）。 */
export function channelAvailability (batch) {
  const channels = { T: false, L: false, G: false, C: false, S: false }
  for (const sample of batch.samples ?? []) {
    for (const key of Object.keys(channels)) {
      if (sample.channels?.[key] !== undefined) channels[key] = true
    }
  }
  return channels
}

function samplesOfGroup (batch, group) {
  return (batch.samples ?? []).filter((sample) => sample.channels?.[group] !== undefined && sample.error === undefined)
}

function topKSetOfSample (sample) {
  const set = []
  const topK = sample.channels?.L?.topK ?? []
  topK.forEach((alternatives, position) => {
    for (const token of alternatives) set.push(`${position}:${token}`)
  })
  return set
}

function signatureOfT (batch, probes) {
  const tProbes = probes.filter((probe) => probe.group === 'T')
  if (tProbes.length === 0) return null
  const vector = []
  for (const probe of tProbes) {
    const sample = (batch.samples ?? []).find((row) => row.probeId === probe.probeId && row.channels?.T !== undefined && row.error === undefined)
    const promptTokens = sample?.channels?.T?.promptTokens
    if (!Number.isInteger(promptTokens)) return null
    vector.push(promptTokens)
  }
  return { vector, hash: sha256Of(vector) }
}

function signatureOfL (batch) {
  const samples = samplesOfGroup(batch, 'L')
  if (samples.length === 0) return null
  const allLogprobs = []
  const sequences = []
  for (const sample of samples) {
    const logprobs = sample.channels.L.logprobs ?? []
    for (const value of logprobs) if (typeof value === 'number') allLogprobs.push(value)
    sequences.push((sample.channels.L.tokens ?? []).join('\u0000'))
  }
  const sets = samples.map(topKSetOfSample).filter((set) => set.length > 0)
  const pairScores = []
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) pairScores.push(jaccard(sets[i], sets[j]))
  }
  return {
    samples: samples.length,
    tokenSamples: sequences.length,
    distinctTokenSequences: new Set(sequences).size,
    logprobMedian: median(allLogprobs),
    logprobIqr: sub(quantile(allLogprobs, 0.75), quantile(allLogprobs, 0.25)),
    topKJaccardMedian: median(pairScores),
    topKJaccardMin: pairScores.length === 0 ? null : Math.min(...pairScores),
    topKJaccardPairs: pairScores.length,
  }
}

function signatureOfG (batch, probes) {
  const gProbes = probes.filter((probe) => probe.group === 'G')
  if (gProbes.length === 0) return null
  const bits = {}
  const successes = []
  const fails = []
  for (const probe of gProbes) {
    const sample = (batch.samples ?? []).find((row) => row.probeId === probe.probeId && row.channels?.G !== undefined && row.error === undefined)
    if (sample === undefined) continue
    const success = sample.channels.G.success === true
    bits[probe.glitchToken ?? probe.probeId] = [success]
    if (success) successes.push(probe.probeId)
    else fails.push(probe.probeId)
  }
  const total = successes.length + fails.length
  return {
    rounds: total === 0 ? 0 : 1,
    tokens: total,
    successes,
    fails,
    failRate: total === 0 ? null : fails.length / total,
    bits,
  }
}

function signatureOfC (batch) {
  const samples = samplesOfGroup(batch, 'C')
  if (samples.length < 2) return null
  const first = samples[0]?.channels.C
  const second = samples[1]?.channels.C
  if (first === undefined || second === undefined) return null
  const ratio = (value) => {
    if (!Number.isInteger(value?.promptTokens) || value.promptTokens <= 0) return null
    return Number.isInteger(value.cachedTokens) ? value.cachedTokens / value.promptTokens : null
  }
  return {
    first: { promptTokens: first.promptTokens ?? null, cachedTokens: first.cachedTokens ?? null, hitRatio: ratio(first) },
    second: { promptTokens: second.promptTokens ?? null, cachedTokens: second.cachedTokens ?? null, hitRatio: ratio(second) },
    // 新增观测口径：第二次请求里被缓存命中的前缀占比；后端被换/重启时它会掉。
    hitRatio: ratio(second),
  }
}

function signatureOfS (batch) {
  const samples = samplesOfGroup(batch, 'S')
  if (samples.length === 0) return null
  const ttfts = samples.map((sample) => sample.channels.S.ttftMs).filter((value) => typeof value === 'number' && Number.isFinite(value))
  const totals = samples.map((sample) => sample.channels.S.totalMs).filter((value) => typeof value === 'number' && Number.isFinite(value))
  return { samples: samples.length, ttftMs: ttfts, ttftMedian: median(ttfts), totalMedian: median(totals) }
}

function sub (left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  return left - right
}

/**
 * 一条批次的数值签名。
 * @param {object} batch - 原始层的一条批次
 * @param {Array<object>} probes - 冻结探针组（用于 T 向量顺序 / G token 列表）
 */
export function signatureOfBatch (batch, probes) {
  const availability = channelAvailability(batch)
  return {
    batchId: batch.batchId,
    at: batch.at,
    provider: batch.provider,
    model: batch.model,
    probeSetHash: batch.probeSetHash,
    endpointId: batch.endpointId ?? null,
    channels: {
      T: signatureOfT(batch, probes),
      L: signatureOfL(batch),
      G: signatureOfG(batch, probes),
      C: signatureOfC(batch),
      S: signatureOfS(batch),
    },
    availability,
  }
}

/**
 * 只保留参与比较的签名（partial 批次、缺 probeSetHash 的批次不许进基线）。
 * 注意：`endpointId` 对官方直连路由是合成的 `direct:<provider>`（没有网关溯源时的稳定分组键）。
 */
export function isComparableBatch (batch, probes) {
  if (batch.partial === true) return false
  if (typeof batch.probeSetHash !== 'string' || batch.probeSetHash.length === 0) return false
  if (typeof batch.endpointId !== 'string' || batch.endpointId.length === 0) return false
  const usable = probes.filter((probe) => probe.group !== 'C').length
  const expected = usable
  const present = new Set((batch.samples ?? []).filter((sample) => sample.error === undefined).map((sample) => sample.probeId))
  if (present.size < expected) return false
  return true
}
