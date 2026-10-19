// driftmon · 原始层读取的兼容归一化（不回写原始层）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAllRawBatches } from '../src/paths.mjs'

test('readAllRawBatches：缺 endpointId 的批次补 direct:<provider>，已有序号保持不变，原始文件不落改', async () => {
  const raw = await mkdtemp(join(tmpdir(), 'driftmon-raw-'))
  const paths = { raw }
  const filed = join(raw, '2026-10-19.jsonl')
  const records = [
    { batchId: 'b1', provider: 'deepseek-official', model: 'deepseek-flash', samples: [] },
    { batchId: 'b2', provider: 'opencode-go', model: 'deepseek-v4.1-flash', endpointId: 'manhattan-project', samples: [] },
    { batchId: 'b3', provider: '', model: 'x', samples: [] },
  ]
  await writeFile(filed, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')

  const batches = await readAllRawBatches(paths)
  assert.deepEqual(batches.map((batch) => batch.endpointId), ['direct:deepseek-official', 'manhattan-project', undefined])
  assert.equal(batches[1].endpointId, 'manhattan-project', '已有网关端点不能被覆盖')

  const onDisk = (await readFile(filed, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(onDisk[0].endpointId, undefined, '读取归一化不得回写原始层')
})
