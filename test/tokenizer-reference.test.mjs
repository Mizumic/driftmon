// driftmon · 官方 tokenizer 参考（T 通道核验）测试
//
// 这组测试把「官方背书」变成可回归的断言：
//   1) 入库的参考工件必须与冻结探针组、已知检查点模板的 T 向量一致——工件不能被悄悄改坏；
//   2) match / mismatch / insufficient 的比对语义固定；
//   3) CLI 端到端不联网可用，并写出可回溯的核验结果。
//
// 工件本身由 scripts/build-tokenizer-reference.py 用官方的 deepseek-recipe + v41 tokenizer
// 离线生成（见 docs/TOKENIZER-REFERENCE.md），测试只消费、不生成。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.mjs'
import { appendRawBatch, rawFileFor } from '../src/paths.mjs'
import {
  compareToTokenizerReference,
  tokenizerProbeIds,
  validateTokenizerReference,
} from '../src/tokenizer-reference.mjs'
import { TEST_PROBES_DIR, makeStableBatches } from './helpers.mjs'
import { loadProbeSet } from '../src/probe-set.mjs'

const { probeSet, probeSetHash } = await loadProbeSet(TEST_PROBES_DIR)
const REFERENCE = JSON.parse(
  await readFile(new URL('../data/reference/official-tokenizer-v41.json', import.meta.url), 'utf8')
)
const TEMPLATE = JSON.parse(
  await readFile(new URL('../data/templates/checkpoint-flash_1017.json', import.meta.url), 'utf8')
)
const PROVIDER = 'opencode-test'
const MODEL = 'test-model'

function batchesOf (tVector, count = 3, startAt = 1_000_000, overrides = {}) {
  return makeStableBatches(probeSet.probes, count, { probeSetHash, tVector, startAt, ...overrides })
}

test('参考工件：结构合法，且与冻结探针组 / 已知检查点模板的 T 向量一致', () => {
  assert.deepEqual(validateTokenizerReference(REFERENCE, { probeSetHash, probes: probeSet.probes }), [])
  assert.deepEqual(tokenizerProbeIds(REFERENCE.probes), tokenizerProbeIds(probeSet.probes))

  // 官方参考值必须与「flash 1017」模板里固化的 T 向量逐项相等 —— 这就是模板的官方背书。
  assert.deepEqual(REFERENCE.vector, TEMPLATE.channels.T.vector)
  assert.deepEqual(REFERENCE.vector, [18, 17, 17, 39, 16])

  // 工件必须记录可追溯的参考实现与 tokenizer 内容哈希。
  assert.equal(REFERENCE.referenceImplementation.package, 'deepseek-recipe')
  assert.match(REFERENCE.referenceImplementation.version, /^\d+\.\d+\.\d+$/u)
  assert.match(REFERENCE.tokenizer.sha256, /^sha256:[0-9a-f]{64}$/u)

  // t-special 探针：special token 字面按普通文本编码（39），按完整词表编码会更短（29）。
  // 这是官方「防文本注入控制 token」语义的直接证据，也是该探针存在的意义。
  const special = REFERENCE.probes.find((row) => row.probeId === 't-special')
  assert.equal(special.promptTokens, 39)
  assert.equal(special.fullVocabularyTokens, 29)
})

test('参考工件自检：探针组换版 / T 组顺序变化会被拒绝', () => {
  const stale = validateTokenizerReference(REFERENCE, { probeSetHash: 'sha256:deadbeef' })
  assert.ok(stale.some((problem) => problem.includes('probeSet.hash')), stale.join('\n'))

  const reordered = validateTokenizerReference(REFERENCE, {
    probeSetHash,
    probes: [...probeSet.probes].reverse(),
  })
  assert.ok(reordered.some((problem) => problem.includes('探针顺序')), reordered.join('\n'))
})

test('比对：实测向量与官方参考一致 → match', () => {
  const compared = compareToTokenizerReference({
    batches: batchesOf(REFERENCE.vector),
    probes: probeSet.probes,
    reference: REFERENCE,
    provider: PROVIDER,
    model: MODEL,
    windowBatches: 3,
    now: 1,
  })
  assert.equal(compared.status, 'match')
  assert.deepEqual(compared.observed.vectors, [REFERENCE.vector])
  assert.deepEqual(compared.diffs, [])
})

test('比对：向量偏差 → mismatch，逐探针给出 expected/observed', () => {
  const observed = [18, 17, 17, 38, 16]
  const compared = compareToTokenizerReference({
    batches: batchesOf(observed),
    probes: probeSet.probes,
    reference: REFERENCE,
    provider: PROVIDER,
    model: MODEL,
    windowBatches: 3,
    now: 1,
  })
  assert.equal(compared.status, 'mismatch')
  assert.ok(compared.detail.includes('不一致'))
  assert.deepEqual(compared.diffs, [{ probeId: 't-special', expected: 39, observed: 38 }])
})

test('比对：没有可用批次 / 探针组不一致 / partial 批次 → insufficient', () => {
  const empty = compareToTokenizerReference({
    batches: [],
    probes: probeSet.probes,
    reference: REFERENCE,
    provider: PROVIDER,
    model: MODEL,
  })
  assert.equal(empty.status, 'insufficient')

  const wrongProbeSet = batchesOf(REFERENCE.vector).map((batch) => ({ ...batch, probeSetHash: 'sha256:other' }))
  const mismatched = compareToTokenizerReference({
    batches: wrongProbeSet,
    probes: probeSet.probes,
    reference: REFERENCE,
    provider: PROVIDER,
    model: MODEL,
  })
  assert.equal(mismatched.status, 'insufficient')

  const partial = batchesOf(REFERENCE.vector).map((batch) => ({ ...batch, partial: true }))
  const partialOnly = compareToTokenizerReference({
    batches: partial,
    probes: probeSet.probes,
    reference: REFERENCE,
    provider: PROVIDER,
    model: MODEL,
  })
  assert.equal(partialOnly.status, 'insufficient')
})

async function setupWorkspace () {
  const root = await mkdtemp(join(tmpdir(), 'driftmon-ref-'))
  const data = join(root, 'data')
  const results = join(root, 'results')
  const raw = join(data, 'raw')
  const batches = makeStableBatches(probeSet.probes, 3, { probeSetHash, tVector: REFERENCE.vector })
  for (const batch of batches) await appendRawBatch(rawFileFor({ raw }, batch.at), batch)

  // 工件是入库文件，测试把它复制进临时 data/ 目录（CLI 按 paths.data/reference 找）。
  await mkdir(join(data, 'reference'), { recursive: true })
  await writeFile(join(data, 'reference', 'official-tokenizer-v41.json'), JSON.stringify(REFERENCE), 'utf8')

  const configFile = join(root, 'config.json')
  await writeFile(configFile, JSON.stringify({
    paths: { data, results, probes: TEST_PROBES_DIR },
    provider: {
      id: PROVIDER,
      api: 'openai-completions',
      baseURL: 'https://example.invalid/v1',
      model: MODEL,
      apiKeyEnv: 'NOT_USED_IN_TESTS',
    },
  }, null, 2), 'utf8')
  return { root, data, results, configFile, raw }
}

test('CLI 端到端：reference check 输出 match / mismatch 并写出可回溯结果（不联网）', async () => {
  const { results, configFile, raw } = await setupWorkspace()
  const originalLog = console.log
  const logs = []
  console.log = (...args) => logs.push(args.join(' '))
  try {
    assert.equal(await main(['reference', 'check', '--config', configFile, '--json']), 0)
  } finally {
    console.log = originalLog
  }
  const record = JSON.parse(logs.join('\n'))
  assert.equal(record.status, 'match')
  assert.equal(record.kind, 'official-tokenizer-check')
  assert.deepEqual(record.expected.vector, REFERENCE.vector)

  const checkFile = join(results, 'reference', 'tokenizer-check.json')
  const written = JSON.parse(await readFile(checkFile, 'utf8'))
  assert.equal(written.status, 'match')
  assert.equal(written.provider, PROVIDER)
  assert.equal(written.model, MODEL)

  // 再追加一批「新的、T 向量不对」的批次，--window 1 只比最新一批 → mismatch。
  const drifted = makeStableBatches(probeSet.probes, 1, {
    probeSetHash,
    tVector: [18, 17, 17, 38, 16],
    startAt: 5_000_000,
  })
  for (const batch of drifted) await appendRawBatch(rawFileFor({ raw }, batch.at), batch)

  const mismatchLogs = []
  console.log = (...args) => mismatchLogs.push(args.join(' '))
  try {
    assert.equal(await main(['reference', 'check', '--config', configFile, '--window', '1', '--json']), 0)
  } finally {
    console.log = originalLog
  }
  const mismatched = JSON.parse(mismatchLogs.join('\n'))
  assert.equal(mismatched.status, 'mismatch')
  assert.deepEqual(mismatched.diffs, [{ probeId: 't-special', expected: 39, observed: 38 }])
})
