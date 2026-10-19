import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalProbeSet, computeProbeSetHash, loadProbeSet, validateProbeSet } from '../src/probe-set.mjs'
import { TEST_PROBES_DIR } from './helpers.mjs'

test('探针组可以加载，哈希稳定且带版本', async () => {
  const first = await loadProbeSet(TEST_PROBES_DIR)
  const second = await loadProbeSet(TEST_PROBES_DIR)
  assert.equal(first.probeSetHash, second.probeSetHash)
  assert.match(first.probeSetHash, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(first.probeSet.probeSetVersion, '0.1.0-phase0')
  assert.ok(first.probeSet.probes.length > 0)
  for (const group of ['T', 'L', 'G', 'C', 'S']) {
    assert.ok(first.probeSet.probes.some((probe) => probe.group === group), `缺少 ${group} 组`)
  }
})

test('哈希对对象键顺序不敏感，但对探针内容敏感', async () => {
  const { probeSet } = await loadProbeSet(TEST_PROBES_DIR)
  const baseline = computeProbeSetHash(probeSet)
  const reordered = JSON.parse(JSON.stringify(probeSet))
  for (const probe of reordered.probes) {
    const entries = Object.entries(probe).reverse()
    for (const key of Object.keys(probe)) delete probe[key]
    for (const [key, value] of entries) probe[key] = value
  }
  assert.equal(computeProbeSetHash(reordered), baseline, '仅键顺序变化不应改变哈希')

  const tampered = JSON.parse(JSON.stringify(probeSet))
  tampered.probes[0].prompt = tampered.probes[0].prompt + 'x'
  assert.notEqual(computeProbeSetHash(tampered), baseline, '探针内容变化必须改变哈希')
})

test('顶层元数据（除 probeSetVersion）不参与哈希', async () => {
  const { probeSet } = await loadProbeSet(TEST_PROBES_DIR)
  const changed = { ...probeSet, description: 'another description', createdAt: '2099-01-01' }
  assert.equal(computeProbeSetHash(changed), computeProbeSetHash(probeSet))
  const versionChanged = { ...probeSet, probeSetVersion: '9.9.9' }
  assert.notEqual(computeProbeSetHash(versionChanged), computeProbeSetHash(probeSet))
})

test('canonicalProbeSet 去掉探针说明性字段、保留探针字段', async () => {
  const { probeSet } = await loadProbeSet(TEST_PROBES_DIR)
  const withNote = JSON.parse(JSON.stringify(probeSet))
  withNote.probes[0].note = '说明不算定义'
  withNote.probes[0].glitchToken = 'x'
  const canonical = canonicalProbeSet(withNote)
  assert.equal(canonical.probes[0].note, undefined)
  assert.equal(canonical.probes[0].glitchToken, 'x')
})

test('C 组前缀被改过时拒绝加载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftmon-probes-'))
  await cp(join(TEST_PROBES_DIR, 'probe-set.json'), join(dir, 'probe-set.json'))
  await cp(join(TEST_PROBES_DIR, 'cache-prefix.txt'), join(dir, 'cache-prefix.txt'))
  const prefix = await readFile(join(dir, 'cache-prefix.txt'), 'utf8')
  await writeFile(join(dir, 'cache-prefix.txt'), prefix + 'tampered', 'utf8')
  await assert.rejects(() => loadProbeSet(dir), /sha256|前缀被改过/u)
})

test('非法探针组被拒（重复 probeId / 非法 group / 超长 maxTokens）', async () => {
  const { probeSet } = await loadProbeSet(TEST_PROBES_DIR)
  const duplicate = JSON.parse(JSON.stringify(probeSet))
  duplicate.probes.push({ ...duplicate.probes[0] })
  assert.throws(() => validateProbeSet(duplicate), /probeId 重复/u)

  const badGroup = JSON.parse(JSON.stringify(probeSet))
  badGroup.probes[0].group = 'X'
  assert.throws(() => validateProbeSet(badGroup), /group 不合法/u)

  const huge = JSON.parse(JSON.stringify(probeSet))
  huge.probes[0].maxTokens = 1024
  assert.throws(() => validateProbeSet(huge), /maxTokens/u)
})
