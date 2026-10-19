import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProbeSet } from '../src/probe-set.mjs'
import { buildBaseline } from '../src/baseline.mjs'
import { independentGroups, judge } from '../src/judge.mjs'
import { TEST_HASH, makeBatch, makeStableBatches, testConfig } from './helpers.mjs'

const { probeSet } = await loadProbeSet(new URL('../probes/', import.meta.url).pathname)
const probes = probeSet.probes
const config = testConfig()
const providerId = 'opencode-test'
const model = 'test-model'

function baselineOf (batches) {
  return buildBaseline({ batches, probes, providerId, model, probeSetHash: TEST_HASH, windowBatches: 30 })
}

function judgeOf (batches, baseline, options = {}) {
  return judge({ batches, probes, baseline, config: options.config ?? config, providerId, model })
}

test('样本量不足 → insufficient（合法结论，不是报错）', () => {
  const batches = makeStableBatches(probes, 1) // 36 样本
  const baseline = baselineOf(batches)
  const verdict = judgeOf(batches, baseline, { config: testConfig({ judge: { nMin: 100 } }) })
  assert.equal(verdict.verdict, 'insufficient')
  assert.equal(verdict.reason, 'not-enough-samples')
  assert.equal(verdict.signals.length, 0)
})

test('窗口内出现多个端点 → route-change，而不是 drift-candidate', () => {
  const batches = [
    ...makeStableBatches(probes, 2, { endpointId: 'endpoint-a', startAt: 1_000_000 }),
    ...makeStableBatches(probes, 2, { endpointId: 'endpoint-b', tVector: [44, 43, 43, 64, 42], startAt: 2_000_000 }),
  ]
  const baseline = baselineOf(batches.filter((batch) => batch.endpointId === 'endpoint-a'))
  const verdict = judgeOf(batches, baseline)
  assert.equal(verdict.verdict, 'route-change')
  assert.equal(verdict.reason, 'multiple-endpoints-in-window')
  assert.deepEqual(verdict.endpoints.map((row) => row.endpointId).sort(), ['endpoint-a', 'endpoint-b'])
})

test('同一端点、全部通道在噪声内 → stable', () => {
  const batches = makeStableBatches(probes, 5)
  const baseline = baselineOf(batches)
  const verdict = judgeOf(batches, baseline)
  assert.equal(verdict.verdict, 'stable')
  assert.equal(verdict.reason, 'all-channels-within-noise')
  assert.equal(verdict.endpointId, 'endpoint-a')
  assert.equal(verdict.baselineVersion, baseline.baselineVersion)
  assert.equal(verdict.probeSetHash, TEST_HASH)
  assert.deepEqual(verdict.thresholds, config.judge.thresholds, '判定必须带阈值')
})

test('该端点没有基线 → insufficient（不许硬判）', () => {
  const baseline = baselineOf(makeStableBatches(probes, 2, { endpointId: 'endpoint-a' }))
  const batches = makeStableBatches(probes, 5, { endpointId: 'endpoint-b', startAt: 2_000_000 })
  const verdict = judgeOf(batches, baseline)
  assert.equal(verdict.verdict, 'insufficient')
  assert.equal(verdict.reason, 'no-baseline-for-endpoint')
  assert.equal(verdict.endpointId, 'endpoint-b')
})

test('单通道超阈值 → drift-candidate（多通道一致才升级）', () => {
  const stable = makeStableBatches(probes, 5)
  const baseline = baselineOf(stable)
  const changed = makeBatch({ probes, at: 5_000_000, endpointId: 'endpoint-a', tVector: [64, 43, 43, 36, 42] })
  const verdict = judgeOf([...stable, changed], baseline)
  assert.equal(verdict.verdict, 'drift-candidate')
  assert.equal(verdict.reason, 'channel-exceeded-noise')
  assert.deepEqual(verdict.independentGroups, ['T'])
  assert.equal(verdict.signals[0].channel, 'T')
  assert.equal(verdict.signals[0].direction, 'changed')
})

test('多通道同向且连续两批复现 → drift-confirmed', () => {
  const stable = makeStableBatches(probes, 5, { gFailCount: 7 })
  const baseline = baselineOf(stable)
  const changedT = [64, 43, 43, 36, 42]
  const changed1 = makeBatch({ probes, at: 5_000_000, endpointId: 'endpoint-a', tVector: changedT, gFailCount: 14 })
  const changed2 = makeBatch({ probes, at: 5_060_000, endpointId: 'endpoint-a', tVector: changedT, gFailCount: 14 })
  const verdict = judgeOf([...stable, changed1, changed2], baseline)
  assert.equal(verdict.verdict, 'drift-confirmed')
  assert.equal(verdict.reason, 'multi-channel-shift-reproduced')
  assert.ok(verdict.independentGroups.length >= 2)
  assert.ok(verdict.previous, 'confirmed 必须带上一批的证据')
})

test('只有一刹那的多通道异常（上一批正常）→ 仍是 candidate', () => {
  const stable = makeStableBatches(probes, 5, { gFailCount: 7 })
  const baseline = baselineOf(stable)
  const changed = makeBatch({ probes, at: 5_000_000, endpointId: 'endpoint-a', tVector: [64, 43, 43, 36, 42], gFailCount: 14 })
  const verdict = judgeOf([...stable, changed], baseline)
  assert.equal(verdict.verdict, 'drift-candidate')
})

test('L 与 S 同源，只算一个独立来源', () => {
  const groups = independentGroups([
    { channel: 'L', source: 'deploy', direction: 'down' },
    { channel: 'S', source: 'deploy', direction: 'up' },
    { channel: 'T', source: 'T', direction: 'changed' },
  ])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.source).sort(), ['T', 'deploy'])
})

test('判定可拿同一批原始数据重放两次结果一致', () => {
  const batches = makeStableBatches(probes, 5)
  const baseline = baselineOf(batches)
  const first = judgeOf(batches, baseline)
  const second = judgeOf(JSON.parse(JSON.stringify(batches)), baseline)
  assert.equal(first.verdict, second.verdict)
  assert.deepEqual(first.signals, second.signals)
})
