import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.mjs'
import { appendRawBatch, rawFileFor } from '../src/paths.mjs'
import { TEST_PROBES_DIR, makeStableBatches } from './helpers.mjs'
import { loadProbeSet } from '../src/probe-set.mjs'

const { probeSet, probeSetHash } = await loadProbeSet(TEST_PROBES_DIR)

async function setupWorkspace () {
  const root = await mkdtemp(join(tmpdir(), 'driftmon-cli-'))
  const paths = {
    root,
    raw: join(root, 'data', 'raw'),
    baselines: join(root, 'data', 'baselines'),
    alerts: join(root, 'results', 'alerts'),
    reports: join(root, 'results', 'reports'),
  }
  const batches = makeStableBatches(probeSet.probes, 5, { probeSetHash })
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
  return { root, paths, configFile }
}

test('CLI 端到端：baseline build → judge run → report（不联网）', async () => {
  const { paths, configFile } = await setupWorkspace()
  const originalLog = console.log
  const originalError = console.error
  const logs = []
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => logs.push(args.join(' '))
  try {
    assert.equal(await main(['baseline', 'build', '--config', configFile]), 0)
    assert.equal(await main(['judge', 'run', '--config', configFile]), 0)
    assert.equal(await main(['report', '--config', configFile]), 0)
    assert.equal(await main(['status', '--config', configFile]), 0)
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  const output = logs.join('\n')
  assert.match(output, /基线已写入/u)
  assert.match(output, /stable/u)
  assert.match(output, /报告已写入/u)
  assert.match(output, /被动层依赖/u)

  const baselineFile = join(paths.baselines, 'opencode-test--test-model.json')
  const baseline = JSON.parse(await readFile(baselineFile, 'utf8'))
  assert.equal(baseline.probeSetHash, probeSetHash)
  assert.equal(baseline.baselineVersion, 1)

  const { readdir } = await import('node:fs/promises')
  const alertFiles = await readdir(paths.alerts)
  assert.equal(alertFiles.length, 1, 'judge run 必须落一份告警文件')
  const alerts = alertFiles.map((name) => join(paths.alerts, name))
  const alert = JSON.parse(await readFile(alerts[0], 'utf8'))
  assert.equal(alert.verdict, 'stable')
})

test('CLI：没有基线时 judge 报错并返回 2（拒绝硬判）', async () => {
  const { configFile } = await setupWorkspace()
  const originalError = console.error
  const errors = []
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const code = await main(['judge', 'run', '--config', configFile])
    assert.equal(code, 2)
  } finally {
    console.error = originalError
  }
  assert.match(errors.join('\n'), /没有基线/u)
})

test('CLI：探针组换版后拒绝与旧基线比较', async () => {
  const { paths, configFile } = await setupWorkspace()
  const originalError = console.error
  const errors = []
  console.error = (...args) => errors.push(args.join(' '))
  try {
    // 先建基线，再把基线的 probeSetHash 改成别的版本
    assert.equal(await main(['baseline', 'build', '--config', configFile]), 0)
    const file = join(paths.baselines, 'opencode-test--test-model.json')
    const baseline = JSON.parse(await readFile(file, 'utf8'))
    baseline.probeSetHash = 'sha256:older-probe-set'
    await writeFile(file, JSON.stringify(baseline, null, 2), 'utf8')
    const code = await main(['judge', 'run', '--config', configFile])
    assert.equal(code, 2)
  } finally {
    console.error = originalError
  }
  assert.match(errors.join('\n'), /拒绝比较/u)
})
