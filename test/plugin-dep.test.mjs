import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SUPPORTED_CONFIG_SCHEMA_VERSION,
  SUPPORTED_ENDPOINTS_SCHEMA_VERSION,
  describeEndpoint,
  loadPluginConfig,
  loadPluginDependency,
} from '../src/plugin-dep.mjs'

async function storageWith (payload) {
  const dir = await mkdtemp(join(tmpdir(), 'driftmon-dep-'))
  if (payload !== undefined) {
    await writeFile(join(dir, 'endpoints.json'), typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  }
  return dir
}

test('读取插件 endpoints.json（v1）：端点、模型、计数', async () => {
  const dir = await storageWith({
    version: SUPPORTED_ENDPOINTS_SCHEMA_VERSION,
    updatedAt: 1792227751000,
    endpoints: {
      'orcarouter-dsv4.1flash': {
        endpointId: 'orcarouter-dsv4.1flash',
        firstSeenAt: 1792220000000,
        lastSeenAt: 1792227751000,
        count: 42,
        sources: { capture: 40, probe: 2 },
        models: { 'deepseek-v4.1-flash': { count: 42 } },
        lastContext: { sessionId: 's1', logId: 'log-1' },
      },
      'manhattan-project': {
        endpointId: 'manhattan-project',
        count: 7,
        models: { 'deepseek-v4.1-flash': { count: 7 } },
      },
    },
  })
  const dependency = await loadPluginDependency(dir)
  assert.equal(dependency.found, true)
  assert.equal(dependency.version, 1)
  assert.equal(dependency.endpoints.length, 2)
  assert.deepEqual([...dependency.models], ['deepseek-v4.1-flash'])
  assert.equal(dependency.warnings.length, 0)
  assert.deepEqual(describeEndpoint(dependency, 'manhattan-project'), {
    registered: true,
    models: ['deepseek-v4.1-flash'],
    lastSeenAt: null,
    counted: 7,
    lastContext: null,
  })
  assert.equal(describeEndpoint(dependency, 'unknown-endpoint').registered, false)
})

test('插件没装 / 文件不存在：优雅降级，不抛错', async () => {
  const dir = await storageWith()
  const dependency = await loadPluginDependency(dir)
  assert.equal(dependency.found, false)
  assert.match(dependency.error, /不存在/u)
  assert.equal(describeEndpoint(dependency, 'x').registered, false)
})

test('endpoints.json 损坏：报错但不抛错', async () => {
  const dir = await storageWith('{ not json')
  const dependency = await loadPluginDependency(dir)
  assert.equal(dependency.found, false)
  assert.match(dependency.error, /不是合法 JSON/u)
})

test('不认识的 schema 版本：告警但仍读已知字段（两个仓库独立升级）', async () => {
  const dir = await storageWith({
    version: 99,
    updatedAt: 1,
    endpoints: { 'endpoint-x': { endpointId: 'endpoint-x', count: 3, models: {} } },
  })
  const dependency = await loadPluginDependency(dir)
  assert.equal(dependency.found, true)
  assert.equal(dependency.version, 99)
  assert.equal(dependency.endpoints.length, 1)
  assert.equal(dependency.warnings.length, 1)
  assert.match(dependency.warnings[0], /不一致/u)
})

async function storageWithConfig (payload) {
  const dir = await mkdtemp(join(tmpdir(), 'driftmon-cfg-'))
  if (payload !== undefined) {
    await writeFile(join(dir, 'config.json'), typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  }
  return dir
}

test('读取插件 config.json（v1）：路由、开关、台账与当前检查点', async () => {
  const dir = await storageWithConfig({
    version: SUPPORTED_CONFIG_SCHEMA_VERSION,
    updatedAt: 1792427000000,
    note: 'fixture',
    plugin: { name: 'dsh-system-fingerprint', version: '0.2.0', stateApiVersion: 1 },
    probe: {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      openaiBaseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      timeoutMs: 15000,
      cacheTtlMs: 60000,
      stabilityChecks: 1,
    },
    capture: { enabled: true, rawEnabled: false, headersEnabled: true, hosts: ['api.deepseek.com'] },
    gateway: { enabled: true, hosts: ['opencode.ai'], sessionHeader: 'x-opencode-session', headers: [{ key: 'endpointId', header: 'x-opencode-endpoint-id' }] },
    checkpoints: [
      { name: 'v4-pro', fingerprint: 'a307abda487cd1b463329ccb945ce396' },
      { name: 'flash 1017', fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501' },
      { broken: true },
    ],
    checkpoint: {
      fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
      name: 'flash 1017',
      source: 'probe',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      probedAt: 1792426999000,
      endpointHost: 'api.deepseek.com',
      confidence: 'high',
    },
  })
  const exported = await loadPluginConfig(dir)
  assert.equal(exported.found, true)
  assert.equal(exported.version, 1)
  assert.equal(exported.warnings.length, 0)
  assert.equal(exported.probe.provider, 'deepseek-official')
  assert.equal(exported.capture.rawEnabled, false)
  assert.equal(exported.gateway.headers[0].header, 'x-opencode-endpoint-id')
  assert.deepEqual(exported.checkpoints.map((entry) => entry.name), ['v4-pro', 'flash 1017'], '坏条目应被跳过')
  assert.deepEqual(exported.checkpoint, {
    fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
    name: 'flash 1017',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    probedAt: 1792426999000,
    endpointHost: 'api.deepseek.com',
    confidence: 'high',
  })
})

test('config.json 缺失 / 损坏 / 版本不认识：优雅降级，不影响采集', async () => {
  const missing = await storageWithConfig()
  const a = await loadPluginConfig(missing)
  assert.equal(a.found, false)
  assert.match(a.error, /不存在/u)

  const corrupt = await storageWithConfig('{ not json')
  const b = await loadPluginConfig(corrupt)
  assert.equal(b.found, false)
  assert.match(b.error, /不是合法 JSON/u)

  const future = await storageWithConfig({ version: 99, probe: { provider: 'x' }, checkpoint: { fingerprint: 'f'.repeat(32), name: 'future' } })
  const c = await loadPluginConfig(future)
  assert.equal(c.found, true)
  assert.equal(c.version, 99)
  assert.equal(c.warnings.length, 1)
  assert.match(c.warnings[0], /不一致/u)
  assert.equal(c.probe.provider, 'x', '版本不认识也要读已知字段')
  assert.equal(c.checkpoint.fingerprint, 'f'.repeat(32))
})
