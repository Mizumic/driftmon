import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProbeSet } from '../src/probe-set.mjs'
import { buildNoiseFloor, noiseFloorSummary, USABILITY_CRITERIA } from '../src/noise-floor.mjs'
import { TEST_HASH, makeBatch, makeStableBatches } from './helpers.mjs'

const { probeSet } = await loadProbeSet(new URL('../probes/', import.meta.url).pathname)
const probes = probeSet.probes

function floorOf (batches, overrides = {}) {
  return buildNoiseFloor({
    batches,
    probes,
    providerId: 'opencode-test',
    model: 'test-model',
    probeSetHash: TEST_HASH,
    rounds: 5,
    sessionsPerRound: 8,
    ...overrides,
  })
}

test('noise-floor：按端点分组统计，稳定端点的 T 唯一、五个通道均可判定', () => {
  const batches = makeStableBatches(probes, 40, { endpointId: 'endpoint-a', tVector: [44, 43, 43, 36, 42] })
  const floor = floorOf(batches)
  assert.equal(floor.formatVersion, 1)
  assert.equal(floor.kind, 'noise-floor')
  assert.equal(floor.window.batches, 40)
  assert.equal(floor.window.rounds, 5)
  assert.equal(floor.summary.verdict, 'calibrated')
  const endpoint = floor.endpoints['endpoint-a']
  assert.equal(endpoint.batches, 40)
  assert.equal(endpoint.channels.T.distinctVectors, 1)
  assert.equal(endpoint.channels.T.usable, true)
  assert.equal(endpoint.channels.G.tokens, 14 * 40)
  assert.equal(endpoint.channels.G.failRate, 0.5)
  assert.deepEqual(endpoint.usableChannels, ['T', 'L', 'G', 'C', 'S'])
  assert.deepEqual(endpoint.unusableChannels, {})
  assert.deepEqual(floor.summary.judgementUsable, ['T', 'L', 'G', 'C', 'S'])
  assert.ok(noiseFloorSummary(floor).some((line) => line.includes('endpoint-a')))
})

test('noise-floor：同端点内出现两种 T 向量 → T 不可用并给出原因', () => {
  const batches = [
    ...makeStableBatches(probes, 20, { endpointId: 'endpoint-a', tVector: [44, 43, 43, 36, 42], startAt: 1_000_000 }),
    ...makeStableBatches(probes, 20, { endpointId: 'endpoint-a', tVector: [44, 43, 43, 64, 42], startAt: 3_000_000 }),
  ]
  const floor = floorOf(batches)
  const endpoint = floor.endpoints['endpoint-a']
  assert.equal(endpoint.channels.T.distinctVectors, 2)
  assert.equal(endpoint.channels.T.usable, false)
  assert.match(String(endpoint.unusableChannels.T), /2 种 T 向量/u)
  assert.equal(floor.summary.judgementUsable.includes('T'), false)
})

test('noise-floor：partial / 其他探针组 / 其他 provider 的批次不计入窗口', () => {
  const batches = [
    ...makeStableBatches(probes, 8, { endpointId: 'endpoint-a' }),
    makeBatch({ probes, at: 2_000_000, endpointId: 'endpoint-a', partial: true }),
    makeBatch({ probes, at: 2_000_100, endpointId: 'endpoint-a', probeSetHash: 'sha256:other-probe-set' }),
    makeBatch({ probes, at: 2_000_200, endpointId: 'endpoint-a', provider: 'other-provider' }),
  ]
  const floor = floorOf(batches, { rounds: 30 })
  assert.equal(floor.window.batches, 8)
  assert.equal(floor.skipped.partial, 1)
  assert.equal(floor.skipped.otherProbeSet, 1)
  assert.equal(floor.skipped.otherProviderModel, 1)
  assert.equal(floor.summary.verdict, 'insufficient-window')
  assert.match(floor.summary.message, /不足|尚未达标/u)
})

test('noise-floor：--rounds 只取最近 N 轮（按 sessionsPerRound 折算批数）', () => {
  const batches = makeStableBatches(probes, 40, { endpointId: 'endpoint-a' })
  const floor = floorOf(batches, { rounds: 2, sessionsPerRound: 8 })
  assert.equal(floor.window.batches, 16)
  assert.equal(floor.window.rounds, 2)
  assert.equal(floor.endpoints['endpoint-a'].batches, 16)
})

test('noise-floor：L top-k 不稳定 / S 尾部过大 → 标记不可用并给出原因', () => {
  const batches = []
  for (let index = 0; index < 40; index += 1) {
    const batch = makeBatch({
      probes,
      at: 1_000_000 + index * 60_000,
      endpointId: 'endpoint-a',
      // 后两批 TTFT 远高于其余 → p95/p50 > 3
      ttft: index < 38 ? 100 : 5000,
    })
    // 同一批内让 L 样本的 top-k 集合两两不相交 → 批内 Jaccard=0 → top-k 通道不稳定
    for (const [sampleIndex, sample] of batch.samples.entries()) {
      if (sample.group !== 'L' || sample.channels?.L === undefined) continue
      sample.channels.L.topK = sampleIndex % 2 === 0
        ? [['a', 'b'], ['c', 'd'], ['e', 'f']]
        : [['g', 'h'], ['i', 'j'], ['k', 'l']]
    }
    batches.push(batch)
  }
  const floor = floorOf(batches)
  const endpoint = floor.endpoints['endpoint-a']
  assert.equal(endpoint.channels.L.usable, false)
  assert.match(String(endpoint.unusableChannels.L), /top-k Jaccard/u)
  assert.equal(endpoint.channels.S.usable, false)
  assert.match(String(endpoint.unusableChannels.S), /TTFT p95\/p50/u)
  assert.equal(floor.summary.judgementUsable.includes('L'), false)
  assert.equal(floor.summary.judgementUsable.includes('S'), false)
})

test('noise-floor：没有可用批次时抛错（提示先跑 Phase 0 采集）', () => {
  assert.throws(
    () => floorOf([], { rounds: 30 }),
    /没有可用于构建噪声底的批次/u,
  )
})

test('noise-floor：判定口径对五个通道都有书面说明', () => {
  for (const channel of ['T', 'L', 'G', 'C', 'S']) {
    assert.equal(typeof USABILITY_CRITERIA[channel], 'string')
    assert.ok(USABILITY_CRITERIA[channel].length > 0)
  }
})
