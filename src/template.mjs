// driftmon · 已知检查点的「行为向量模板」
//
// 模板 = 某个**已知检查点**（由官方 system_fingerprint 认定）在冻结探针组下的签名参考：
//   * T：token 计数向量（tokenizer / 计费口径；逐字节确定）
//   * L：logprob / top-k 分布（模型权重敏感；官方端点 logprob 数值可能退化为 0，top-k 集仍可用）
//   * G：glitch token 复述失败向量（权重/分词器行为；批次级统计）
//   * C：prompt cache 命中（服务栈/配置）
//   * S：TTFT（服务栈/负载）
//
// 用途：
//   1. 无指纹的网关端点反推检查点（行为对模板）；
//   2. 官方端点「指纹没变、行为变了」的灰度/静默变更检测。
//
// 模板是派生层：从 append-only 原始层重建，随时可重算；不写原始层。

import { channelAvailability, median, quantile, signatureOfBatch } from './signature.mjs'

export const TEMPLATE_VERSION = 1
export const TEMPLATE_KIND = 'known-checkpoint-template'

function samplesOf (batch) {
  return Array.isArray(batch?.samples) ? batch.samples : []
}

/** 一条批次里出现最多的非空 system_fingerprint（流式样本解析不到正文时为 null）。 */
export function batchFingerprint (batch) {
  const counts = new Map()
  let total = 0
  for (const sample of samplesOf(batch)) {
    total += 1
    if (typeof sample.fingerprint !== 'string' || sample.fingerprint.length === 0) continue
    counts.set(sample.fingerprint, (counts.get(sample.fingerprint) ?? 0) + 1)
  }
  let fingerprint = null
  let matched = 0
  for (const [value, count] of counts) {
    if (count > matched) {
      fingerprint = value
      matched = count
    }
  }
  return { fingerprint, samples: matched, total }
}

/** 该批次能否用于某检查点的模板（完整批次、探针组一致、指纹对得上）。 */
export function isTemplateBatch (batch, { probeSetHash, fingerprint }) {
  if (batch === null || typeof batch !== 'object') return false
  if (batch.partial === true) return false
  if (typeof batch.probeSetHash !== 'string' || batch.probeSetHash !== probeSetHash) return false
  return batchFingerprint(batch).fingerprint === fingerprint
}

function uniqueValues (values, label) {
  const unique = new Map()
  for (const value of values) {
    if (value === undefined) continue
    const key = JSON.stringify(value)
    if (!unique.has(key)) unique.set(key, value)
  }
  const out = [...unique.values()]
  if (out.length > 1) {
    throw new Error(`${label} 在批次间不一致（${out.length} 种）：不能把不同行为混进同一个检查点模板`)
  }
  return out[0]
}

function aggregateT (signatures) {
  const vectors = signatures.map((signature) => signature.channels.T?.vector).filter(Array.isArray)
  const vector = uniqueValues(vectors, 'T 向量')
  if (vector === undefined) return { available: false, reason: 'no-t-data' }
  const hashes = signatures.map((signature) => signature.channels.T?.hash).filter((value) => typeof value === 'string')
  return {
    available: true,
    /** 官方 tokenizer/计费口径参考值；同端点内应逐项确定。 */
    vector,
    hash: hashes[0] ?? null,
    batches: vectors.length,
    identicalAcrossBatches: true,
  }
}

function aggregateL (signatures) {
  const present = signatures.map((signature) => signature.channels.L).filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return { available: false, reason: 'no-l-data' }
  const medians = present.map((value) => value.topKJaccardMedian).filter(Number.isFinite)
  const logprobMedians = present.map((value) => value.logprobMedian).filter(Number.isFinite)
  // 官方端点会把 logprob 数值上报成 0（退化），但 top-k 集合仍然反映概率排序。
  const probabilitiesDegenerate = logprobMedians.length > 0 && logprobMedians.every((value) => value === 0)
  return {
    available: true,
    batches: present.length,
    /** 各批次内部 12 个样本两两 top-k 集合 Jaccard 中位数；跨批次取中位。 */
    topKJaccardMedian: median(medians),
    topKJaccardRange: medians.length === 0 ? null : [Math.min(...medians), Math.max(...medians)],
    /** 每次采样的输出 token 序列种数；稳定模型应为 1（temperature 0 也不保证，见 PREREQUISITES §2.1）。 */
    distinctTokenSequences: Math.round(median(present.map((value) => value.distinctTokenSequences))),
    logprobMedian: logprobMedians.length === 0 ? null : median(logprobMedians),
    probabilitiesDegenerate,
    note: probabilitiesDegenerate
      ? '该端点把 logprob 数值上报为 0（概率数值不可用），但 top-k token 集合仍反映分布排序，仍可做灰度对比'
      : null,
  }
}

function aggregateG (signatures) {
  const present = signatures.map((signature) => signature.channels.G).filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return { available: false, reason: 'no-g-data' }
  const tokens = [...new Set(present.flatMap((value) => Object.keys(value.bits ?? {})))]
  const perToken = {}
  for (const token of tokens) {
    let successes = 0
    let rounds = 0
    for (const value of present) {
      const bits = value.bits?.[token]
      if (!Array.isArray(bits)) continue
      for (const success of bits) {
        rounds += 1
        if (success === true) successes += 1
      }
    }
    perToken[token] = { rounds, successRate: rounds === 0 ? null : successes / rounds }
  }
  const failRates = present.map((value) => value.failRate).filter(Number.isFinite)
  const failSets = present.map((value) => [...value.fails].sort().join('|'))
  const identicalFailSets = new Set(failSets).size === 1
  return {
    available: true,
    batches: present.length,
    roundsPerBatch: Math.round(median(present.map((value) => value.rounds))),
    failRateMedian: median(failRates),
    failRateRange: failRates.length === 0 ? null : [Math.min(...failRates), Math.max(...failRates)],
    /** 复述失败的 token 集合是否在批次间完全一致（官方端点实测一致；网关可能逐轮漂移）。 */
    identicalFailSets,
    failsPerBatch: present.map((value) => value.fails),
    perToken,
    note: identicalFailSets ? null : '失败集合逐批变化：这是 glitch 通道的正常波动，判定要用失败率而不是集合相等',
  }
}

function aggregateC (signatures) {
  const present = signatures.map((signature) => signature.channels.C).filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return { available: false, reason: 'no-c-data' }
  const ratios = present.map((value) => value.hitRatio).filter(Number.isFinite)
  const prefixTokens = uniqueValues(present.map((value) => value.second?.promptTokens), 'C 组前缀 token 数')
  return {
    available: true,
    batches: present.length,
    prefixTokens: prefixTokens ?? null,
    hitRatioMedian: median(ratios),
    hitRatioRange: ratios.length === 0 ? null : [Math.min(...ratios), Math.max(...ratios)],
    note: 'cache 命中率对服务栈/前缀模板敏感；掉下来不一定是模型变了',
  }
}

function aggregateS (signatures) {
  const present = signatures.map((signature) => signature.channels.S).filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return { available: false, reason: 'no-s-data' }
  const ttftMedians = present.map((value) => value.ttftMedian).filter(Number.isFinite)
  return {
    available: true,
    batches: present.length,
    ttftMedian: median(ttftMedians),
    ttftRangeMs: ttftMedians.length === 0 ? null : [Math.min(...ttftMedians), Math.max(...ttftMedians)],
    samplesPerBatch: Math.round(median(present.map((value) => value.samples))),
    note: 'TTFT 是服务栈/负载信号，不是模型信号；只作辅助佐证',
  }
}

function modeOfSessions (batches) {
  const sessions = batches.map((batch) => samplesOf(batch).find((sample) => typeof sample.session === 'string')?.session ?? null)
  return sessions.filter((value) => value !== null)
}

/**
 * 从原始层批次构建「已知检查点行为模板」。
 *
 * @param {object} options
 * @param {Array<object>} options.batches - 原始层全部批次
 * @param {Array<object>} options.probes - 冻结探针组
 * @param {string} options.probeSetHash
 * @param {string} options.probeSetVersion
 * @param {{fingerprint:string,name?:string}} options.checkpoint - 已知检查点（fingerprint 来自官方响应）
 * @param {{id:string,baseURL?:string,model?:string}} options.provider
 * @param {number} [options.now]
 */
export function buildCheckpointTemplate (options) {
  const { probes, probeSetHash, probeSetVersion, checkpoint, provider } = options
  const fingerprint = typeof checkpoint?.fingerprint === 'string' ? checkpoint.fingerprint.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{32}$/u.test(fingerprint)) {
    throw new Error('checkpoint.fingerprint 必须是 32 位小写 hex（官方 system_fingerprint）')
  }
  if (!Array.isArray(probes) || probes.length === 0) throw new Error('缺少冻结探针组')
  const usable = options.batches.filter((batch) => isTemplateBatch(batch, { probeSetHash, fingerprint }))
  if (usable.length === 0) {
    throw new Error(`没有可用的完整批次：需要 partial=false、probeSetHash=${probeSetHash}、且样本里出现 fingerprint=${fingerprint}`)
  }
  const signatures = usable.map((batch) => signatureOfBatch(batch, probes))
  const availability = {}
  for (const key of ['T', 'L', 'G', 'C', 'S']) {
    availability[key] = usable.some((batch) => channelAvailability(batch)[key] === true)
  }
  const samples = usable.reduce((sum, batch) => sum + samplesOf(batch).length, 0)
  // 指纹证据覆盖：多少个样本真的回了这个 system_fingerprint（流式样本解析不到正文，天然为 0）。
  const fingerprintSamples = usable.reduce((sum, batch) => sum + batchFingerprint(batch).samples, 0)
  const errors = usable.reduce((sum, batch) => sum + samplesOf(batch).filter((sample) => sample.error !== undefined).length, 0)
  const times = usable.map((batch) => batch.at).filter(Number.isFinite)
  const now = options.now ?? Date.now()
  return {
    version: TEMPLATE_VERSION,
    kind: TEMPLATE_KIND,
    generatedAt: now,
    note: '已知检查点的行为签名参考（派生层，可从 data/raw 重建）；指纹来自官方 system_fingerprint。',
    probeSet: { version: probeSetVersion, hash: probeSetHash },
    checkpoint: {
      name: typeof checkpoint.name === 'string' && checkpoint.name.length > 0 ? checkpoint.name : null,
      fingerprint,
      source: 'system_fingerprint',
    },
    provider: {
      id: provider?.id ?? null,
      baseURL: provider?.baseURL ?? null,
      model: provider?.model ?? null,
    },
    window: {
      batches: usable.length,
      sessions: modeOfSessions(usable).length,
      samples,
      fingerprintSamples,
      errors,
      from: times.length === 0 ? null : Math.min(...times),
      to: times.length === 0 ? null : Math.max(...times),
    },
    availability,
    channels: {
      T: aggregateT(signatures),
      L: aggregateL(signatures),
      G: aggregateG(signatures),
      C: aggregateC(signatures),
      S: aggregateS(signatures),
    },
    interpretation: {
      fingerprintChannel: 'system_fingerprint',
      /** 权重敏感通道：灰度换权重但指纹不变时，优先看这两个。 */
      behaviorChannels: ['L', 'G'],
      /** 配置/计费口径通道。 */
      configChannels: ['T', 'C'],
      /** 服务栈/负载通道（不是模型信号）。 */
      infraChannels: ['S'],
      note: '指纹变了 = 官方配置变更（直接可见）；指纹不变但 behaviorChannels 分布偏移/双峰 = 疑似灰度。',
    },
  }
}

/** 模板自检（CLI/测试共用；不依赖外部状态）。 */
export function validateTemplate (template) {
  const problems = []
  if (template === null || typeof template !== 'object') return ['模板不是对象']
  if (template.version !== TEMPLATE_VERSION) problems.push(`version 应为 ${TEMPLATE_VERSION}，实际 ${String(template.version)}`)
  if (template.kind !== TEMPLATE_KIND) problems.push(`kind 应为 ${TEMPLATE_KIND}`)
  if (typeof template.probeSet?.hash !== 'string' || template.probeSet.hash.length === 0) problems.push('缺 probeSet.hash')
  if (!/^[0-9a-f]{32}$/u.test(String(template.checkpoint?.fingerprint ?? ''))) problems.push('checkpoint.fingerprint 不是 32 位 hex')
  const t = template.channels?.T
  if (t?.available === true && (!Array.isArray(t.vector) || !t.vector.every(Number.isInteger))) problems.push('T.vector 必须是整数数组')
  if (!Number.isInteger(template.window?.batches) || template.window.batches <= 0) problems.push('window.batches 必须是正整数')
  return problems
}

export function templateSummary (template) {
  const channels = Object.entries(template.channels ?? {})
    .filter(([, value]) => value?.available === true)
    .map(([key]) => key)
    .join(',')
  return [
    `${template.checkpoint.name ?? '(未命名)'} · ${template.checkpoint.fingerprint}`,
    `probeSet=${template.probeSet.hash.slice(0, 20)}… · ${template.window.batches} 批 / ${template.window.samples} 样本 · 通道 ${channels || '—'}`,
    `T 向量=${JSON.stringify(template.channels.T.vector)} · G 失败率=${template.channels.G.failRateMedian} · C 命中=${template.channels.C.hitRatioMedian}`,
  ].join('\n')
}
