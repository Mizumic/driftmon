// driftmon · 已知检查点模板（纯函数 + CLI 端到端，不联网）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendRawBatch, rawFileFor } from '../src/paths.mjs'
import { main } from '../src/cli.mjs'
import {
  TEMPLATE_KIND,
  TEMPLATE_VERSION,
  batchFingerprint,
  buildCheckpointTemplate,
  validateTemplate,
} from '../src/template.mjs'
import { TEST_HASH, TEST_PROBES_DIR, makeStableBatches } from './helpers.mjs'
import { loadProbeSet } from '../src/probe-set.mjs'

const { probeSet, probeSetHash } = await loadProbeSet(TEST_PROBES_DIR)
const FP = 'e72d3c7f663d3e1383b00b3884cb4501'

/** 给批次里的非流式样本挂上官方 system_fingerprint；每个批次换一个 session，统计更真实。 */
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

function build (batches, overrides = {}) {
  return buildCheckpointTemplate({
    batches,
    probes: probeSet.probes,
    probeSetHash,
    probeSetVersion: probeSet.probeSetVersion,
    checkpoint: { fingerprint: FP, name: 'flash 1017' },
    provider: { id: 'deepseek-official', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' },
    now: 1792435200000,
    ...overrides,
  })
}

test('模板构建：T/L/G/C/S 聚合、指纹绑定、窗口统计', () => {
  const tVector = [18, 17, 17, 39, 16]
  const batches = withFingerprint(makeStableBatches(probeSet.probes, 3, {
    probeSetHash,
    tVector,
    gFailCount: 3,
    ttft: 120,
  }))
  const template = build(batches)
  assert.equal(template.version, TEMPLATE_VERSION)
  assert.equal(template.kind, TEMPLATE_KIND)
  assert.equal(template.checkpoint.fingerprint, FP)
  assert.equal(template.checkpoint.name, 'flash 1017')
  assert.equal(template.provider.id, 'deepseek-official')
  assert.equal(template.probeSet.hash, probeSetHash)
  assert.equal(template.window.batches, 3)
  assert.equal(template.window.sessions, 3)
  assert.equal(template.window.errors, 0)
  assert.equal(template.window.samples, batches.reduce((sum, batch) => sum + batch.samples.length, 0))
  const streamSamples = batches.reduce((sum, batch) => sum + batch.samples.filter((sample) => sample.group === 'S').length, 0)
  assert.equal(template.window.fingerprintSamples, template.window.samples - streamSamples, '指纹覆盖要排除流式样本')
  assert.deepEqual(template.availability, { T: true, L: true, G: true, C: true, S: true })

  assert.deepEqual(template.channels.T.vector, tVector)
  assert.ok(/^sha256:[0-9a-f]{64}$/u.test(template.channels.T.hash))
  assert.equal(template.channels.T.identicalAcrossBatches, true)

  assert.equal(template.channels.G.available, true)
  assert.equal(template.channels.G.failRateMedian, 3 / 14)
  assert.equal(template.channels.G.identicalFailSets, true)
  const glitchTokens = probeSet.probes.filter((probe) => probe.group === 'G').map((probe) => probe.glitchToken).sort()
  assert.deepEqual(Object.keys(template.channels.G.perToken).sort(), glitchTokens, '14 个 glitch token 都要有跨批成功率')

  assert.equal(template.channels.C.available, true)
  assert.ok(template.channels.C.hitRatioMedian > 0.9 && template.channels.C.hitRatioMedian <= 1)
  assert.equal(template.channels.S.available, true)
  assert.ok(template.channels.S.ttftMedian >= 120)

  assert.equal(template.channels.L.available, true)
  assert.ok(template.channels.L.topKJaccardMedian !== null)

  assert.deepEqual(template.interpretation.behaviorChannels, ['L', 'G'])
  assert.deepEqual(validateTemplate(template), [])
})

test('模板构建：T 向量批次间不一致时拒绝（不同 tokenizer 不能混成一个模板）', () => {
  const a = withFingerprint(makeStableBatches(probeSet.probes, 1, { probeSetHash, tVector: [18, 17, 17, 39, 16] }))
  const b = withFingerprint(makeStableBatches(probeSet.probes, 1, { probeSetHash, tVector: [18, 17, 17, 64, 16], startAt: 2_000_000 }))
  assert.throws(() => build([...a, ...b]), /T 向量 在批次间不一致/u)
})

test('模板构建：指纹对不上 / partial / 探针组换版的批次都被排除', () => {
  const good = withFingerprint(makeStableBatches(probeSet.probes, 2, { probeSetHash }))
  const wrongFingerprint = withFingerprint(makeStableBatches(probeSet.probes, 1, { probeSetHash, startAt: 2_000_000 }), '0123456789abcdef0123456789abcdef')
  const partial = withFingerprint(makeStableBatches(probeSet.probes, 1, { probeSetHash, startAt: 3_000_000 })).map((batch) => ({ ...batch, partial: true }))
  const changedProbeSet = withFingerprint(makeStableBatches(probeSet.probes, 1, { probeSetHash: 'sha256:other-probe-set', startAt: 4_000_000 }))
  const template = build([...good, ...wrongFingerprint, ...partial, ...changedProbeSet])
  assert.equal(template.window.batches, 2)
  assert.throws(() => build([...wrongFingerprint]), /没有可用的完整批次/u)
})

test('模板构建：L 通道不可用时标 unavailable，模板仍可用', () => {
  const batches = withFingerprint(makeStableBatches(probeSet.probes, 2, { probeSetHash })).map((batch) => ({
    ...batch,
    samples: batch.samples.filter((sample) => sample.group !== 'L'),
  }))
  const template = build(batches)
  assert.equal(template.channels.L.available, false)
  assert.equal(template.channels.L.reason, 'no-l-data')
  assert.equal(template.availability.L, false)
  assert.deepEqual(validateTemplate(template), [])
})

test('batchFingerprint：按非空样本取众数，忽略流式 null', () => {
  const batches = withFingerprint(makeStableBatches(probeSet.probes, 1, { probeSetHash }))
  const summary = batchFingerprint(batches[0])
  assert.equal(summary.fingerprint, FP)
  assert.equal(summary.samples, batches[0].samples.length - batches[0].samples.filter((sample) => sample.group === 'S').length)
  assert.equal(summary.total, batches[0].samples.length)
})

test('validateTemplate：坏模板要报出问题', () => {
  const good = build(withFingerprint(makeStableBatches(probeSet.probes, 2, { probeSetHash })))
  const problems = validateTemplate({ ...good, version: 99, checkpoint: { fingerprint: 'nope' }, channels: { T: { available: true, vector: ['x'] } } })
  assert.ok(problems.length >= 3, `应报多处问题：${JSON.stringify(problems)}`)
})

test('CLI：template build 从原始层生成并落盘（不联网）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'driftmon-template-'))
  const paths = {
    root,
    raw: join(root, 'data', 'raw'),
    baselines: join(root, 'data', 'baselines'),
    templates: join(root, 'data', 'templates'),
    alerts: join(root, 'results', 'alerts'),
    reports: join(root, 'results', 'reports'),
  }
  const batches = withFingerprint(makeStableBatches(probeSet.probes, 3, {
    probeSetHash,
    tVector: [18, 17, 17, 39, 16],
    gFailCount: 3,
    ttft: 120,
  }))
  for (const batch of batches) await appendRawBatch(rawFileFor(paths, batch.at), batch)
  const configFile = join(root, 'config.json')
  await writeFile(configFile, JSON.stringify({
    paths: {
      data: join(root, 'data'),
      results: join(root, 'results'),
      probes: TEST_PROBES_DIR,
    },
    provider: {
      id: 'opencode-test',
      api: 'openai-completions',
      baseURL: 'https://example.invalid/v1',
      model: 'test-model',
      apiKeyEnv: 'NOT_USED_IN_TESTS',
    },
  }, null, 2), 'utf8')

  const originalLog = console.log
  const originalError = console.error
  const logs = []
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => logs.push(args.join(' '))
  let code
  try {
    code = await main(['template', 'build', '--config', configFile, '--fingerprint', FP, '--name', 'flash 1017'])
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  assert.equal(code, 0, logs.join('\n'))
  assert.match(logs.join('\n'), /模板已写入/u)
  const file = join(paths.templates, 'checkpoint-flash_1017.json')
  const template = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(template.checkpoint.fingerprint, FP)
  assert.equal(template.checkpoint.name, 'flash 1017')
  assert.deepEqual(template.channels.T.vector, [18, 17, 17, 39, 16])
  assert.equal(template.window.batches, 3)
})

test('CLI：template build 缺 --fingerprint 时返回 2 并说明用法', async () => {
  const root = await mkdtemp(join(tmpdir(), 'driftmon-template-bad-'))
  const configFile = join(root, 'config.json')
  await writeFile(configFile, JSON.stringify({ paths: { data: join(root, 'data'), results: join(root, 'results'), probes: TEST_PROBES_DIR } }, null, 2), 'utf8')
  const originalError = console.error
  const errors = []
  console.error = (...args) => errors.push(args.join(' '))
  let code
  try {
    code = await main(['template', 'build', '--config', configFile])
  } finally {
    console.error = originalError
  }
  assert.equal(code, 2)
  assert.match(errors.join('\n'), /--fingerprint/u)
})
