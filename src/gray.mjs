// driftmon · 行为告警（已知检查点模板对比）
//
// 输入：一份已知检查点模板（data/templates/*.json）+ 最新窗口的完整批次（data/raw）
// 输出：一个判定 + 一份「通用告警文件」（schema v1，可被外部展示层读取；driftmon 不关心谁读）。
//
// 判定是保守的、可解释的：
//   insufficient      窗口样本不够，不给结论
//   checkpoint-change 指纹与模板不同（官方换了检查点/配置）
//   gray-candidate    指纹相同，但行为通道（L top-k / G）超出模板噪声 → 疑似灰度/静默变更
//   config-change     指纹相同，但 T 向量或 C 命中变化 → tokenizer/缓存/服务栈配置变化
//   infra-change      仅 S（TTFT）异常 → 服务栈/负载，不是模型信号
//   stable            全部在模板范围内
//
// 这里只比较「模板里记录的通道」；缺失通道跳过（不把缺数据当异常）。

import { batchFingerprint } from './template.mjs'
import { median, signatureOfBatch } from './signature.mjs'

export const WATCH_SCHEMA_VERSION = 1

/** 默认阈值。Phase 0 标定后按噪声底替换（与 judge.thresholds 同理）。 */
export const GRAY_DEFAULT_THRESHOLDS = {
  /** G 组失败率相对模板的绝对偏移（0.2 = 20 个百分点）。 */
  gFailRateDelta: 0.2,
  /** 单 token「期望必成/必败」翻转所需的最少轮次（避免单轮偶然）。 */
  gPerTokenFlipMinRounds: 8,
  /** L top-k Jaccard 低于模板最小值多少算偏移。 */
  lTopKJaccardDrop: 0.08,
  /** C 命中率相对模板绝对下降多少算异常。 */
  cHitRatioDrop: 0.2,
  /** TTFT 相对模板中位数的倍数（超过算服务栈变化）。 */
  sTtftRatio: 1.8,
  /** 少于这么多批次不下结论。 */
  minBatches: 2,
}

function usableBatches (batches, template) {
  return batches.filter((batch) => {
    if (batch.partial === true) return false
    if (batch.probeSetHash !== template.probeSet?.hash) return false
    if (batch.provider !== template.provider?.id) return false
    if (batch.model !== template.provider?.model) return false
    return true
  })
}

function uniqueFingerprints (batches) {
  const found = new Map()
  for (const batch of batches) {
    const { fingerprint } = batchFingerprint(batch)
    if (typeof fingerprint === 'string' && fingerprint.length > 0) found.set(fingerprint, (found.get(fingerprint) ?? 0) + 1)
  }
  return found
}

function pooledG (signatures) {
  const present = signatures.map((signature) => signature.channels.G).filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return null
  // 按 token 聚合（每个 token 每批 1 轮）；不能用 value.rounds——那是「批内轮次数」不是 token 轮次。
  const perToken = {}
  for (const value of present) {
    for (const [token, bits] of Object.entries(value.bits ?? {})) {
      const entry = perToken[token] ?? { rounds: 0, successes: 0 }
      for (const success of bits) {
        entry.rounds += 1
        if (success === true) entry.successes += 1
      }
      perToken[token] = entry
    }
  }
  const totalRounds = Object.values(perToken).reduce((sum, entry) => sum + entry.rounds, 0)
  const totalSuccesses = Object.values(perToken).reduce((sum, entry) => sum + entry.successes, 0)
  return {
    batches: present.length,
    tokenRounds: totalRounds,
    failRate: totalRounds === 0 ? null : (totalRounds - totalSuccesses) / totalRounds,
    perToken,
  }
}

function pooledL (signatures) {
  const present = signatures.map((signature) => signature.channels.L).filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return null
  return {
    batches: present.length,
    topKJaccardMedian: median(present.map((value) => value.topKJaccardMedian).filter(Number.isFinite)),
    distinctTokenSequences: present.map((value) => value.distinctTokenSequences).filter(Number.isFinite),
  }
}

function pooledC (signatures) {
  const present = signatures.map((signature) => signature.channels.C).filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return null
  return { batches: present.length, hitRatioMedian: median(present.map((value) => value.hitRatio).filter(Number.isFinite)) }
}

function pooledS (signatures) {
  const present = signatures.map((signature) => signature.channels.S).filter((value) => value !== null && value !== undefined)
  if (present.length === 0) return null
  return { batches: present.length, ttftMedian: median(present.map((value) => value.ttftMedian).filter(Number.isFinite)) }
}

function signal (channel, verdict, observed, expected, detail) {
  return { channel, verdict, observed, expected, detail }
}

/**
 * 把一个窗口的批次与模板对比。
 *
 * @param {object} options
 * @param {Array<object>} options.batches - 全部原始批次（内部按模板过滤）
 * @param {Array<object>} options.probes - 冻结探针组
 * @param {object} options.template - 模板 JSON
 * @param {object} [options.thresholds] - 覆盖默认阈值
 * @param {number} [options.now]
 * @returns {object} 判定对象（可 JSON 序列化）
 */
export function compareToTemplate (options) {
  const { template } = options
  const thresholds = { ...GRAY_DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) }
  const now = options.now ?? Date.now()
  const batches = usableBatches(Array.isArray(options.batches) ? options.batches : [], template)
  const windowBatches = batches.slice(-Math.max(1, Number.isInteger(options.windowBatches) ? options.windowBatches : 8))
  const result = {
    schemaVersion: WATCH_SCHEMA_VERSION,
    kind: 'behavior-watch',
    at: now,
    level: 'ok',
    verdict: 'insufficient',
    message: '样本不足，暂不下结论',
    template: {
      checkpoint: template.checkpoint ?? null,
      probeSetHash: template.probeSet?.hash ?? null,
    },
    window: { batches: windowBatches.length, samples: 0, from: null, to: null },
    subject: { provider: template.provider?.id ?? null, model: template.provider?.model ?? null },
    signals: [],
    caveats: [],
  }
  if (batches.length === 0) {
    result.caveats.push('没有与该模板匹配的完整批次（探针组/provider/model 不一致，或原始层为空）')
    return result
  }
  const samples = windowBatches.reduce((sum, batch) => sum + (batch.samples?.length ?? 0), 0)
  const times = windowBatches.map((batch) => batch.at).filter(Number.isFinite)
  result.window = {
    batches: windowBatches.length,
    samples,
    from: times.length === 0 ? null : Math.min(...times),
    to: times.length === 0 ? null : Math.max(...times),
  }
  if (windowBatches.length < thresholds.minBatches) {
    result.caveats.push(`窗口只有 ${windowBatches.length} 批（阈值 ${thresholds.minBatches}），继续攒样本`)
    return result
  }

  const signatures = windowBatches.map((batch) => signatureOfBatch(batch, options.probes))
  const expected = template.channels ?? {}
  const channelSignals = []
  const behaviorChanged = []
  const configChanged = []
  const infraChanged = []
  let checkpointChanged = false
  let fingerprintMissing = false

  // 1) 指纹（权威通道）
  const fingerprints = uniqueFingerprints(windowBatches)
  const templateFingerprint = template.checkpoint?.fingerprint ?? null
  if (fingerprints.size === 0) {
    fingerprintMissing = true
    channelSignals.push(signal('system_fingerprint', 'unavailable', null, templateFingerprint, '窗口内没有样本报告指纹（可能全是流式响应）'))
  } else if (templateFingerprint !== null && !fingerprints.has(templateFingerprint)) {
    checkpointChanged = true
    channelSignals.push(signal('system_fingerprint', 'changed', [...fingerprints.keys()], templateFingerprint, '指纹与模板不同：官方换检查点/配置'))
  } else {
    channelSignals.push(signal('system_fingerprint', 'unchanged', [...fingerprints.keys()], templateFingerprint, '指纹与模板一致'))
  }

  // 2) T 向量（tokenizer / 计费口径）
  const tVectors = signatures.map((signature) => signature.channels.T?.vector).filter(Array.isArray)
  const expectedT = expected.T?.available === true ? expected.T.vector : null
  if (expectedT !== null && tVectors.length > 0) {
    const mismatched = tVectors.filter((vector) => JSON.stringify(vector) !== JSON.stringify(expectedT))
    if (mismatched.length > 0) {
      configChanged.push('T')
      channelSignals.push(signal('T', 'changed', mismatched[0], expectedT, 'token 计数向量与模板不同：tokenizer/计费口径变化'))
    } else {
      channelSignals.push(signal('T', 'unchanged', expectedT, expectedT, 'T 向量与模板一致'))
    }
  }

  // 3) G（权重行为；批次级统计）
  const currentG = pooledG(signatures)
  const expectedG = expected.G?.available === true ? expected.G : null
  if (currentG !== null && expectedG !== null && currentG.failRate !== null && Number.isFinite(expectedG.failRateMedian)) {
    const delta = currentG.failRate - expectedG.failRateMedian
    const perTokenFlips = []
    for (const [token, observed] of Object.entries(currentG.perToken)) {
      const wanted = expectedG.perToken?.[token]
      if (wanted === undefined) continue
      if (observed.rounds < thresholds.gPerTokenFlipMinRounds) continue
      const expectedRate = wanted.successRate
      const observedRate = observed.rounds === 0 ? null : observed.successes / observed.rounds
      if (expectedRate === 1 && observedRate < 1) perTokenFlips.push({ token, expected: expectedRate, observed: observedRate })
      if (expectedRate === 0 && observedRate > 0) perTokenFlips.push({ token, expected: expectedRate, observed: observedRate })
    }
    if (Math.abs(delta) > thresholds.gFailRateDelta || perTokenFlips.length > 0) {
      behaviorChanged.push('G')
      channelSignals.push(signal('G', 'changed', currentG.failRate, expectedG.failRateMedian, `失败率偏移 ${(delta * 100).toFixed(1)} 个百分点；逐 token 翻转 ${perTokenFlips.length} 个`))
    } else {
      channelSignals.push(signal('G', 'unchanged', currentG.failRate, expectedG.failRateMedian, 'G 失败率在模板噪声内'))
    }
  } else if (currentG === null) {
    channelSignals.push(signal('G', 'unavailable', null, expectedG?.failRateMedian ?? null, '窗口内没有 G 通道数据'))
  }

  // 4) L（权重行为；top-k 集合分布）
  const currentL = pooledL(signatures)
  const expectedL = expected.L?.available === true ? expected.L : null
  if (currentL !== null && expectedL !== null && Number.isFinite(currentL.topKJaccardMedian) && Number.isFinite(expectedL.topKJaccardMedian)) {
    const templateMin = Array.isArray(expectedL.topKJaccardRange) ? expectedL.topKJaccardRange[0] : expectedL.topKJaccardMedian
    const floor = templateMin - thresholds.lTopKJaccardDrop
    if (currentL.topKJaccardMedian < floor) {
      behaviorChanged.push('L')
      channelSignals.push(signal('L', 'changed', currentL.topKJaccardMedian, expectedL.topKJaccardMedian, `top-k Jaccard ${currentL.topKJaccardMedian.toFixed(3)} 低于模板下界 ${floor.toFixed(3)}`))
    } else {
      channelSignals.push(signal('L', 'unchanged', currentL.topKJaccardMedian, expectedL.topKJaccardMedian, 'L top-k 重合度在模板范围内'))
    }
  } else if (currentL === null) {
    channelSignals.push(signal('L', 'unavailable', null, expectedL?.topKJaccardMedian ?? null, '窗口内没有 L 通道数据'))
  }

  // 5) C（缓存/服务栈配置）
  const currentC = pooledC(signatures)
  const expectedC = expected.C?.available === true ? expected.C : null
  if (currentC !== null && expectedC !== null && Number.isFinite(currentC.hitRatioMedian) && Number.isFinite(expectedC.hitRatioMedian)) {
    const drop = expectedC.hitRatioMedian - currentC.hitRatioMedian
    if (drop > thresholds.cHitRatioDrop) {
      configChanged.push('C')
      channelSignals.push(signal('C', 'changed', currentC.hitRatioMedian, expectedC.hitRatioMedian, `命中率下降 ${(drop * 100).toFixed(1)} 个百分点：服务栈/前缀配置变化`))
    } else {
      channelSignals.push(signal('C', 'unchanged', currentC.hitRatioMedian, expectedC.hitRatioMedian, 'C 命中率在模板噪声内'))
    }
  }

  // 6) S（服务栈/负载）
  const currentS = pooledS(signatures)
  const expectedS = expected.S?.available === true ? expected.S : null
  if (currentS !== null && expectedS !== null && Number.isFinite(currentS.ttftMedian) && Number.isFinite(expectedS.ttftMedian) && expectedS.ttftMedian > 0) {
    const ratio = currentS.ttftMedian / expectedS.ttftMedian
    if (ratio > thresholds.sTtftRatio || ratio < 1 / thresholds.sTtftRatio) {
      infraChanged.push('S')
      channelSignals.push(signal('S', 'changed', currentS.ttftMedian, expectedS.ttftMedian, `TTFT 中位 ${currentS.ttftMedian}ms 是模板的 ${ratio.toFixed(2)} 倍：服务栈/负载变化`))
    } else {
      channelSignals.push(signal('S', 'unchanged', currentS.ttftMedian, expectedS.ttftMedian, 'S 在模板范围内'))
    }
  }

  result.signals = channelSignals
  if (checkpointChanged) {
    result.verdict = 'checkpoint-change'
    result.level = 'warn'
    result.message = '指纹与模板不同：官方检查点/配置已变化（这不是灰度，是可观测的版本变更）'
  } else if (behaviorChanged.length > 0) {
    result.verdict = 'gray-candidate'
    result.level = 'warn'
    result.message = `指纹未变但行为通道偏移（${behaviorChanged.join(',')}）：疑似灰度/静默变更，需连续复现`
  } else if (configChanged.length > 0) {
    result.verdict = 'config-change'
    result.level = 'warn'
    result.message = `指纹未变但配置通道变化（${configChanged.join(',')}）：tokenizer/缓存/服务栈变化`
  } else if (infraChanged.length > 0) {
    result.verdict = 'infra-change'
    result.level = 'info'
    result.message = '仅延迟/服务栈信号变化（S）：不是模型行为信号'
  } else {
    result.verdict = 'stable'
    result.level = 'ok'
    result.message = '全部可测通道都在模板噪声内'
  }
  if (fingerprintMissing) result.caveats.push('窗口内指纹缺失，checkpoint 判定不可用')
  if (behaviorChanged.length > 0) result.caveats.push('gray-candidate 只表示「疑似」，需要连续复现并排除服务端噪声后才可升级')
  return result
}

/** 外部展示层可读的通用告警文件（schema v1）。 */
export function buildWatchAlert (compared, options = {}) {
  return {
    version: WATCH_SCHEMA_VERSION,
    kind: 'behavior-watch',
    level: compared.level,
    verdict: compared.verdict,
    updatedAt: compared.at,
    message: compared.message,
    subject: {
      provider: compared.subject?.provider ?? null,
      model: compared.subject?.model ?? null,
      checkpoint: compared.template?.checkpoint ?? null,
    },
    template: {
      file: options.templateFile ?? null,
      probeSetHash: compared.template?.probeSetHash ?? null,
    },
    window: compared.window,
    signals: compared.signals,
    caveats: compared.caveats,
  }
}
