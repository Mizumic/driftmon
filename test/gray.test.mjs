// driftmon · 行为告警（模板对比）单元测试（不联网）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCheckpointTemplate } from '../src/template.mjs'
import { GRAY_DEFAULT_THRESHOLDS, buildWatchAlert, compareToTemplate } from '../src/gray.mjs'
import { TEST_PROBES_DIR, makeStableBatches } from './helpers.mjs'
import { loadProbeSet } from '../src/probe-set.mjs'

const { probeSet, probeSetHash } = await loadProbeSet(TEST_PROBES_DIR)
const FP = 'e72d3c7f663d3e1383b00b3884cb4501'

function withFingerprint (batches, fingerprint = FP) {
  return batches.map((batch, index) => ({
    ...batch,
    samples: batch.samples.map((sample) => ({
      ...sample,
      session: `sess-${index}`,
      fingerprint: sample.group === 'S' ? null : fingerprint,
    })),
  }))
}

function makeTemplate (overrides = {}) {
  const batches = withFingerprint(makeStableBatches(probeSet.probes, 3, {
    probeSetHash,
    tVector: [18, 17, 17, 39, 16],
    gFailCount: 3,
    ttft: 120,
    ...overrides,
  }))
  return {
    batches,
    template: buildCheckpointTemplate({
      batches,
      probes: probeSet.probes,
      probeSetHash,
      probeSetVersion: probeSet.probeSetVersion,
      checkpoint: { fingerprint: FP, name: 'flash 1017' },
      provider: { id: 'opencode-test', baseURL: 'https://example.invalid/v1', model: 'test-model' },
      now: 1000,
    }),
  }
}

function compare (template, batches, overrides = {}) {
  return compareToTemplate({
    batches,
    probes: probeSet.probes,
    template,
    windowBatches: 8,
    now: 2000,
    ...overrides,
  })
}

test('模板对比：同一检查点的新批次 → stable', () => {
  const { template } = makeTemplate()
  const fresh = withFingerprint(makeStableBatches(probeSet.probes, 8, {
    probeSetHash,
    tVector: [18, 17, 17, 39, 16],
    gFailCount: 3,
    ttft: 118,
    startAt: 10_000_000,
  }))
  const compared = compare(template, fresh)
  assert.equal(compared.verdict, 'stable')
  assert.equal(compared.level, 'ok')
  assert.equal(compared.window.batches, 8)
  assert.equal(compared.signals.find((signal) => signal.channel === 'system_fingerprint').verdict, 'unchanged')
  assert.equal(compared.signals.find((signal) => signal.channel === 'T').verdict, 'unchanged')
})

test('模板对比：指纹变化 → checkpoint-change（优先于行为通道）', () => {
  const { template } = makeTemplate()
  const fresh = withFingerprint(makeStableBatches(probeSet.probes, 8, {
    probeSetHash,
    tVector: [18, 17, 17, 39, 16],
    gFailCount: 3,
    startAt: 10_000_000,
  }), '0123456789abcdef0123456789abcdef')
  const compared = compare(template, fresh)
  assert.equal(compared.verdict, 'checkpoint-change')
  assert.equal(compared.level, 'warn')
  assert.match(compared.message, /指纹与模板不同/u)
})

test('模板对比：指纹不变但 G 失败率偏移 → gray-candidate', () => {
  const { template } = makeTemplate()
  const fresh = withFingerprint(makeStableBatches(probeSet.probes, 8, {
    probeSetHash,
    tVector: [18, 17, 17, 39, 16],
    gFailCount: 10, // 模板是 3/14，这里是 10/14
    startAt: 10_000_000,
  }))
  const compared = compare(template, fresh)
  assert.equal(compared.verdict, 'gray-candidate')
  assert.equal(compared.level, 'warn')
  const g = compared.signals.find((signal) => signal.channel === 'G')
  assert.equal(g.verdict, 'changed')
  assert.match(g.detail, /失败率偏移/u)
})

test('模板对比：T 向量变化 → config-change（tokenizer/计费口径）', () => {
  const { template } = makeTemplate()
  const fresh = withFingerprint(makeStableBatches(probeSet.probes, 8, {
    probeSetHash,
    tVector: [18, 17, 17, 64, 16],
    gFailCount: 3,
    startAt: 10_000_000,
  }))
  const compared = compare(template, fresh)
  assert.equal(compared.verdict, 'config-change')
  assert.match(compared.message, /tokenizer/u)
})

test('模板对比：只有 TTFT 异常 → infra-change（不是模型信号）', () => {
  const { template } = makeTemplate()
  const fresh = withFingerprint(makeStableBatches(probeSet.probes, 8, {
    probeSetHash,
    tVector: [18, 17, 17, 39, 16],
    gFailCount: 3,
    ttft: 900, // 模板 120ms 的 7.5 倍
    startAt: 10_000_000,
  }))
  const compared = compare(template, fresh)
  assert.equal(compared.verdict, 'infra-change')
  assert.equal(compared.level, 'info')
})

test('模板对比：样本不足 → insufficient，不下结论', () => {
  const { template } = makeTemplate()
  const one = withFingerprint(makeStableBatches(probeSet.probes, 1, { probeSetHash, startAt: 10_000_000 }))
  const compared = compare(template, one)
  assert.equal(compared.verdict, 'insufficient')
  assert.ok(compared.caveats.some((caveat) => caveat.includes('窗口只有')))
})

test('模板对比：探针组/路由不匹配的批次被排除，全排除 → insufficient', () => {
  const { template } = makeTemplate()
  const wrongProbeSet = withFingerprint(makeStableBatches(probeSet.probes, 8, { probeSetHash: 'sha256:other', startAt: 10_000_000 }))
  assert.equal(compare(template, wrongProbeSet).verdict, 'insufficient')
  const wrongProvider = withFingerprint(makeStableBatches(probeSet.probes, 8, { probeSetHash, startAt: 10_000_000 }))
    .map((batch) => ({ ...batch, provider: 'other-provider' }))
  assert.equal(compare(template, wrongProvider).verdict, 'insufficient')
})

test('告警文件 schema：版本/等级/主体/窗口/信号齐全', () => {
  const { template } = makeTemplate()
  const fresh = withFingerprint(makeStableBatches(probeSet.probes, 8, {
    probeSetHash,
    tVector: [18, 17, 17, 39, 16],
    gFailCount: 10,
    startAt: 10_000_000,
  }))
  const compared = compare(template, fresh)
  const alert = buildWatchAlert(compared, { templateFile: '/tmp/t.json' })
  assert.equal(alert.version, 1)
  assert.equal(alert.kind, 'behavior-watch')
  assert.equal(alert.level, 'warn')
  assert.equal(alert.verdict, 'gray-candidate')
  assert.equal(alert.subject.provider, 'opencode-test')
  assert.equal(alert.subject.checkpoint.fingerprint, FP)
  assert.equal(alert.template.file, '/tmp/t.json')
  assert.equal(alert.template.probeSetHash, probeSetHash)
  assert.equal(alert.window.batches, 8)
  assert.ok(Array.isArray(alert.signals) && alert.signals.length >= 5)
  assert.ok(alert.signals.every((signal) => typeof signal.channel === 'string' && typeof signal.verdict === 'string' && typeof signal.detail === 'string'))
  assert.deepEqual(GRAY_DEFAULT_THRESHOLDS.minBatches, 2)
})
