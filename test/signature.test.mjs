import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProbeSet } from '../src/probe-set.mjs'
import { isComparableBatch, jaccard, median, quantile, sha256Of, signatureOfBatch } from '../src/signature.mjs'
import { makeBatch } from './helpers.mjs'

const { probeSet } = await loadProbeSet(new URL('../probes/', import.meta.url).pathname)
const probes = probeSet.probes

test('T 通道：向量顺序跟随探针组，哈希是纯函数', () => {
  const tVector = [44, 43, 43, 36, 42]
  const batch = makeBatch({ probes, at: 1000, endpointId: 'endpoint-a', tVector })
  const signature = signatureOfBatch(batch, probes)
  assert.deepEqual(signature.channels.T.vector, tVector)
  assert.equal(signature.channels.T.hash, sha256Of(tVector))
  assert.equal(signature.endpointId, 'endpoint-a')
})

test('L 通道：top-k 重合度 / logprob 中位数', () => {
  const batch = makeBatch({ probes, at: 1000, endpointId: 'endpoint-a' })
  const signature = signatureOfBatch(batch, probes)
  const l = signature.channels.L
  assert.equal(l.samples, 12)
  assert.equal(l.topKJaccardMedian, 1, '同一 top-k 集合的样本两两 Jaccard 应为 1')
  assert.equal(l.logprobMedian, -0.0004)
  assert.ok(l.distinctTokenSequences >= 1)
})

test('G 通道：失败率按多 token 聚合（不是单次结果）', () => {
  const batch = makeBatch({ probes, at: 1000, endpointId: 'endpoint-a', gFailCount: 7 })
  const signature = signatureOfBatch(batch, probes)
  const g = signature.channels.G
  assert.equal(g.tokens, 14)
  assert.equal(g.failRate, 0.5)
  assert.equal(g.fails.length, 7)
})

test('C 通道：读第二次请求的缓存命中率', () => {
  const batch = makeBatch({ probes, at: 1000, endpointId: 'endpoint-a', cProfile: { secondCached: 1440 } })
  const signature = signatureOfBatch(batch, probes)
  const c = signature.channels.C
  assert.equal(c.first.cachedTokens, 0)
  assert.equal(c.second.cachedTokens, 1440)
  assert.ok(c.hitRatio > 0.9)
  assert.equal(c.hitRatio, 1440 / (1500 + 10))
})

test('S 通道：TTFT 中位数', () => {
  const batch = makeBatch({ probes, at: 1000, endpointId: 'endpoint-a', ttft: 800 })
  const signature = signatureOfBatch(batch, probes)
  assert.deepEqual(signature.channels.S.ttftMs, [800, 807, 814])
  assert.equal(signature.channels.S.ttftMedian, 807)
})

test('缺通道时返回 null，而不是 0', () => {
  const batch = makeBatch({ probes, at: 1000, endpointId: 'endpoint-a' })
  batch.samples = batch.samples.filter((sample) => sample.channels.L === undefined)
  const signature = signatureOfBatch(batch, probes)
  assert.equal(signature.channels.L, null)
  assert.equal(signature.availability.L, false)
  assert.equal(signature.availability.T, true)
})

test('partial 批次 / 缺 probeSetHash 的批次不可比较', () => {
  const batch = makeBatch({ probes, at: 1000, endpointId: 'endpoint-a' })
  assert.equal(isComparableBatch(batch, probes), true)
  assert.equal(isComparableBatch({ ...batch, partial: true }, probes), false)
  assert.equal(isComparableBatch({ ...batch, probeSetHash: undefined }, probes), false)
})

test('统计工具：median / quantile / jaccard', () => {
  assert.equal(median([1, 3, 2]), 2)
  assert.equal(median([]), null)
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3)
  assert.equal(jaccard([], []), 1)
})
