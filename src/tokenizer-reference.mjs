// driftmon · 官方 tokenizer 参考（T 通道绝对参照）
//
// 背景：T 通道原来的判据是「与自己的历史基线比」——如果第一次采集时链路就已经被换过，
// 之后永远不会发现。官方开源的参考实现（deepseek-ai/deepseek-recipe，官方称其处理逻辑与
// DeepSeek 官方 API 对齐）可以在**不联网、不调用模型**的前提下，离线算出冻结探针组里每条
// T 探针的期望 prompt_tokens；把结果固化成工件 data/reference/official-tokenizer-v41.json，
// 就有了「官方参考值」可对。
//
// 本模块只做纯函数：读工件形状、把窗口内实测 T 向量与期望向量比对。
// 不生成工件（生成需要 Python + deepseek-recipe，见 scripts/build-tokenizer-reference.py）、
// 不联网、不改原始层。
//
// 语义边界：
//   * 只覆盖 T（tokenizer / prompt 模板 / 计费口径），不参与 L/G/C/S 的漂移判定；
//   * match 表示「tokenizer 与 prompt 模板与官方参考实现一致」，不等于「权重没变」；
//   * mismatch 表示 tokenizer/模板/请求渲染路径变了，或网关改了 prompt（注入 system prompt 等），
//     需要人工判断是哪一种——不能直接当「模型漂移」。

import { signatureOfBatch } from './signature.mjs'

export const TOKENIZER_REFERENCE_VERSION = 1
export const TOKENIZER_REFERENCE_KIND = 'official-tokenizer-reference'
export const TOKENIZER_CHECK_KIND = 'official-tokenizer-check'

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveIntegerArray (value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => Number.isInteger(item) && item > 0)
}

/**
 * 探针 id 顺序：既接受冻结探针组（按 group==='T' 过滤），也接受参考工件里的 probes 行（无 group）。
 */
export function tokenizerProbeIds (probes) {
  return (Array.isArray(probes) ? probes : [])
    .filter((probe) => probe.group === undefined || probe.group === 'T')
    .map((probe) => probe.probeId)
}

/**
 * 参考工件自检。返回问题列表（空数组 = 合法）。
 * @param {object} reference
 * @param {{probeSetHash?: string, probes?: Array<object>}} [options]
 */
export function validateTokenizerReference (reference, options = {}) {
  const problems = []
  if (!isObject(reference)) return ['参考工件不是对象']
  if (reference.version !== TOKENIZER_REFERENCE_VERSION) {
    problems.push(`version 应为 ${TOKENIZER_REFERENCE_VERSION}，实际 ${String(reference.version)}`)
  }
  if (reference.kind !== TOKENIZER_REFERENCE_KIND) {
    problems.push(`kind 应为 ${TOKENIZER_REFERENCE_KIND}`)
  }
  const implementation = reference.referenceImplementation
  if (!isObject(implementation) || typeof implementation.package !== 'string' || implementation.package.length === 0) {
    problems.push('缺 referenceImplementation.package')
  } else if (typeof implementation.version !== 'string' || implementation.version.length === 0) {
    problems.push('缺 referenceImplementation.version')
  }
  if (!isObject(reference.tokenizer) || !/^sha256:[0-9a-f]{64}$/u.test(String(reference.tokenizer?.sha256 ?? ''))) {
    problems.push('tokenizer.sha256 必须是 sha256:<64hex>')
  }
  if (!isObject(reference.probeSet) || typeof reference.probeSet.hash !== 'string' || reference.probeSet.hash.length === 0) {
    problems.push('缺 probeSet.hash')
  } else if (options.probeSetHash !== undefined && reference.probeSet.hash !== options.probeSetHash) {
    problems.push(`工件 probeSet.hash=${reference.probeSet.hash} 与当前探针组 ${options.probeSetHash} 不一致（换过探针组必须重建工件）`)
  }
  if (!isPositiveIntegerArray(reference.vector)) {
    problems.push('vector 必须是非空正整数数组')
  }
  if (!Array.isArray(reference.probes) || reference.probes.length === 0) {
    problems.push('probes 必须是非空数组')
  } else {
    const ids = new Set()
    reference.probes.forEach((row, index) => {
      if (!isObject(row) || typeof row.probeId !== 'string' || row.probeId.length === 0) {
        problems.push(`probes[${index}] 缺 probeId`)
        return
      }
      if (ids.has(row.probeId)) problems.push(`probes 里 probeId 重复：${row.probeId}`)
      ids.add(row.probeId)
      if (!Number.isInteger(row.promptTokens) || row.promptTokens <= 0) {
        problems.push(`${row.probeId} 的 promptTokens 必须是正整数`)
      } else if (Array.isArray(reference.vector) && reference.vector[index] !== row.promptTokens) {
        problems.push(`vector[${index}] 与 ${row.probeId} 的 promptTokens 不一致`)
      }
      if (row.fullVocabularyTokens !== undefined && (!Number.isInteger(row.fullVocabularyTokens) || row.fullVocabularyTokens <= 0)) {
        problems.push(`${row.probeId} 的 fullVocabularyTokens 必须是正整数`)
      }
    })
    if (Array.isArray(reference.vector) && reference.probes.length !== reference.vector.length) {
      problems.push('probes 与 vector 长度不一致')
    }
    if (Array.isArray(options.probes)) {
      const expectedIds = tokenizerProbeIds(options.probes)
      const actualIds = reference.probes.map((row) => row.probeId)
      if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
        problems.push(`工件探针顺序与当前 T 组不一致：工件 ${JSON.stringify(actualIds)} / 当前 ${JSON.stringify(expectedIds)}`)
      }
    }
  }
  return problems
}

/** 参考向量（工件自检通过后用；不做校验）。 */
export function referenceTVector (reference) {
  return Array.isArray(reference?.vector) ? reference.vector : null
}

/**
 * 构造写进检查点模板的 `officialReference` 块（把核验结论固化进「指纹」工件）。
 * 纯函数；调用方负责先用 validateTokenizerReference() 校验工件。
 *
 * @param {object} options
 * @param {object} options.reference - 官方 tokenizer 参考工件
 * @param {number[]|null} [options.tVector] - 模板/窗口的 T 向量（无 T 数据时传 null）
 * @param {number} [options.now]
 */
export function buildOfficialReferenceBlock (options) {
  const expectedVector = referenceTVector(options.reference)
  if (expectedVector === null) throw new Error('参考工件缺 vector，不能固化进模板')
  const reference = options.reference
  return {
    package: reference.referenceImplementation?.package ?? null,
    version: reference.referenceImplementation?.version ?? null,
    sourceCommit: reference.referenceImplementation?.sourceCommit ?? null,
    tokenizerSha256: reference.tokenizer?.sha256 ?? null,
    probeSetHash: reference.probeSet?.hash ?? null,
    expectedVector,
    /** 模板 T 向量是否等于官方期望；模板没有 T 数据时为 null（不是 false）。 */
    vectorMatch: Array.isArray(options.tVector)
      ? JSON.stringify(options.tVector) === JSON.stringify(expectedVector)
      : null,
    checkedAt: options.now ?? Date.now(),
  }
}

/**
 * 校验模板里的 `officialReference` 块（模板自检用）。返回问题列表。
 * @param {object} block
 * @param {{probeSetHash?: string}} [options]
 */
export function validateOfficialReferenceBlock (block, options = {}) {
  const problems = []
  if (!isObject(block)) return ['不是对象']
  for (const key of ['package', 'version', 'sourceCommit', 'tokenizerSha256', 'probeSetHash']) {
    if (typeof block[key] !== 'string' || block[key].length === 0) problems.push(`缺 ${key}`)
  }
  if (typeof block.tokenizerSha256 === 'string' && block.tokenizerSha256.length > 0 && !/^sha256:[0-9a-f]{64}$/u.test(block.tokenizerSha256)) {
    problems.push('tokenizerSha256 必须是 sha256:<64hex>')
  }
  if (!isPositiveIntegerArray(block.expectedVector)) problems.push('expectedVector 必须是非空正整数数组')
  if (!(block.vectorMatch === null || typeof block.vectorMatch === 'boolean')) problems.push('vectorMatch 必须是布尔值或 null')
  if (!Number.isFinite(block.checkedAt)) problems.push('checkedAt 必须是时间戳')
  if (options.probeSetHash !== undefined && block.probeSetHash !== options.probeSetHash) {
    problems.push(`probeSetHash=${block.probeSetHash} 与模板 ${options.probeSetHash} 不一致（换过探针组必须重建工件/模板）`)
  }
  return problems
}

function usableBatches (batches, reference, provider, model) {
  return (Array.isArray(batches) ? batches : []).filter((batch) => {
    if (!isObject(batch) || batch.partial === true) return false
    if (batch.probeSetHash !== reference.probeSet?.hash) return false
    if (provider !== undefined && batch.provider !== provider) return false
    if (model !== undefined && batch.model !== model) return false
    return true
  })
}

function diffsOf (expectedVector, reference, observedVector) {
  return reference.probes.map((row, index) => ({
    probeId: row.probeId,
    expected: expectedVector[index],
    observed: Array.isArray(observedVector) ? observedVector[index] ?? null : null,
  })).filter((row) => row.observed !== row.expected)
}

/**
 * 把窗口内实测 T 向量与官方参考工件比对。
 *
 * @param {object} options
 * @param {Array<object>} options.batches - 全部原始批次（内部过滤 partial / 探针组 / provider / model）
 * @param {Array<object>} options.probes - 冻结探针组（用于从批次重算 T 向量）
 * @param {object} options.reference - 官方参考工件
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {number} [options.windowBatches] - 取最近多少批（默认 8）
 * @param {number} [options.now]
 * @returns {object} 可 JSON 序列化的比对结果
 */
export function compareToTokenizerReference (options) {
  const { reference } = options
  const expectedVector = referenceTVector(reference)
  if (expectedVector === null) throw new Error('参考工件缺 vector，不能比对')
  const now = options.now ?? Date.now()
  const windowSize = Number.isInteger(options.windowBatches) && options.windowBatches > 0 ? options.windowBatches : 8
  const usable = usableBatches(options.batches, reference, options.provider, options.model)
  const windowBatches = usable.slice(-windowSize)
  const result = {
    version: 1,
    kind: TOKENIZER_CHECK_KIND,
    at: now,
    status: 'insufficient',
    detail: '窗口内没有可用于核验的完整批次',
    reference: {
      package: reference.referenceImplementation?.package ?? null,
      version: reference.referenceImplementation?.version ?? null,
      sourceCommit: reference.referenceImplementation?.sourceCommit ?? null,
      tokenizerSha256: reference.tokenizer?.sha256 ?? null,
      probeSetHash: reference.probeSet?.hash ?? null,
    },
    window: { batches: windowBatches.length, from: null, to: null },
    expected: { vector: expectedVector, probes: reference.probes },
    observed: { vectors: [], batches: 0, skipped: 0 },
    diffs: [],
  }
  if (windowBatches.length === 0) {
    result.detail = '没有与参考工件匹配的完整批次（探针组/provider/model 不一致，或原始层为空）'
    return result
  }
  const times = windowBatches.map((batch) => batch.at).filter(Number.isFinite)
  result.window = {
    batches: windowBatches.length,
    from: times.length === 0 ? null : Math.min(...times),
    to: times.length === 0 ? null : Math.max(...times),
  }

  const vectors = []
  let skipped = 0
  for (const batch of windowBatches) {
    let vector = null
    try {
      vector = signatureOfBatch(batch, options.probes).channels.T?.vector ?? null
    } catch {
      vector = null
    }
    if (vector === null) { skipped += 1; continue }
    vectors.push(vector)
  }
  result.observed = { vectors, batches: vectors.length, skipped }
  if (vectors.length === 0) {
    result.detail = '窗口内批次没有完整 T 数据（探针缺失或样本出错）'
    return result
  }

  const unique = new Map()
  for (const vector of vectors) unique.set(JSON.stringify(vector), vector)
  result.observed.vectors = [...unique.values()]
  const mismatched = [...unique.values()].filter((vector) => JSON.stringify(vector) !== JSON.stringify(expectedVector))
  if (mismatched.length === 0) {
    result.status = 'match'
    result.detail = `T 向量与官方参考一致（${vectors.length} 批）：tokenizer / prompt 模板与官方参考实现一致`
    return result
  }
  result.status = 'mismatch'
  result.detail = `T 向量与官方参考不一致（${mismatched.length}/${unique.size} 种观测向量）：tokenizer / prompt 模板 / 请求渲染路径变了，或网关改写了 prompt`
  result.diffs = diffsOf(expectedVector, reference, mismatched[0])
  return result
}

/** 一行摘要（CLI/status 共用）。 */
export function tokenizerReferenceSummary (reference) {
  const implementation = reference.referenceImplementation ?? {}
  const tokenizer = reference.tokenizer ?? {}
  const sha = typeof tokenizer.sha256 === 'string' ? tokenizer.sha256 : ''
  return [
    `${implementation.package ?? '?'} ${implementation.version ?? '?'} · tokenizer ${sha.slice(7, 19)}…`,
    `probeSet=${String(reference.probeSet?.hash ?? '?').slice(0, 24)}… · 期望 T 向量=${JSON.stringify(reference.vector ?? [])}`,
  ]
}

/** 状态图标（CLI 共用）。 */
export function tokenizerCheckIcon (status) {
  return { match: '🟢', mismatch: '🔴', insufficient: '⚪' }[status] ?? '·'
}
