import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProbeSet } from '../src/probe-set.mjs'
import { buildBaseline, markBaselineStale, wilsonInterval } from '../src/baseline.mjs'
import { TEST_HASH, makeStableBatches } from './helpers.mjs'

const { probeSet } = await loadProbeSet(new URL('../probes/', import.meta.url).pathname)
const probes = probeSet.probes

test('基线按端点分组，不跨端点混池', () => {
  const batches = [
    ...makeStableBatches(probes, 2, { endpointId: 'endpoint-a', tVector: [44, 43, 43, 36, 42], startAt: 1_000_000 }),
    ...makeStableBatches(probes, 2, { endpointId: 'endpoint-b', tVector: [44, 43, 43, 64, 42], startAt: 2_000_000 }),
  ]
  const baseline = buildBaseline({
    batches,
    probes,
    providerId: 'opencode-test',
    model: 'test-model',
    probeSetHash: TEST_HASH,
    windowBatches: 30,
  })
  assert.deepEqual(Object.keys(baseline.endpoints).sort(), ['endpoint-a', 'endpoint-b'])
  assert.deepEqual(baseline.endpoints['endpoint-a'].channels.T.vectorSeen, [[44, 43, 43, 36, 42]])
  assert.deepEqual(baseline.endpoints['endpoint-b'].channels.T.vectorSeen, [[44, 43, 43, 64, 42]])
  assert.equal(baseline.endpoints['endpoint-a'].channels.T.distinctVectors, 1, '单端点内部向量应唯一')
  assert.equal(baseline.endpoints['endpoint-a'].samples, 2 * probes.reduce((sum, probe) => sum + probe.samples, 0))
})

test('基线窗口只取最近 windowBatches 批', () => {
  const batches = makeStableBatches(probes, 5)
  const baseline = buildBaseline({ batches, probes, providerId: 'opencode-test', model: 'test-model', probeSetHash: TEST_HASH, windowBatches: 2 })
  assert.equal(baseline.window.batches, 2)
  assert.equal(baseline.endpoints['endpoint-a'].batches, 2)
})

test('基线记录 G/L/C/S 的噪声底统计', () => {
  const batches = makeStableBatches(probes, 3, { gFailCount: 7, ttft: 800 })
  const baseline = buildBaseline({ batches, probes, providerId: 'opencode-test', model: 'test-model', probeSetHash: TEST_HASH })
  const endpoint = baseline.endpoints['endpoint-a']
  assert.equal(endpoint.channels.G.failRate, 0.5)
  assert.ok(Array.isArray(endpoint.channels.G.ci95))
  assert.equal(endpoint.channels.L.topKJaccard.p50, 1)
  assert.ok(endpoint.channels.C.hitRatioMedian > 0.9)
  assert.equal(endpoint.channels.S.ttftP95, 807)
  assert.equal(endpoint.channels.T.distinctVectors, 1)
})

test('探针组换版后旧基线标 stale，不删除', () => {
  const batches = makeStableBatches(probes, 1)
  const baseline = buildBaseline({ batches, probes, providerId: 'opencode-test', model: 'test-model', probeSetHash: TEST_HASH })
  const stale = markBaselineStale(baseline, 'sha256:another-probe-set')
  assert.equal(stale.stale, true)
  assert.equal(stale.staleReason, 'probe-set-changed')
  assert.ok(stale.endpoints['endpoint-a'], '基线内容没有被删掉')
})

test('Wilson 置信区间在 0 与 1 边界上仍然合法', () => {
  const low = wilsonInterval(0, 14)
  assert.ok(low[0] >= 0 && low[1] > 0)
  const high = wilsonInterval(14, 14)
  assert.ok(high[0] < 1 && high[1] <= 1)
  assert.equal(wilsonInterval(0, 0), null)
})
