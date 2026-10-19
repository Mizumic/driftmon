import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadProbeSet } from '../src/probe-set.mjs'
import {
  buildRequest,
  collect,
  glitchReproduced,
  normalizeRepeat,
  provenanceFromHeaders,
  sessionIdFor,
} from '../src/collect.mjs'
import { TEST_PROBES_DIR, tempPaths, testConfig } from './helpers.mjs'

const { probeSet, probeSetHash } = await loadProbeSet(TEST_PROBES_DIR)
const probes = probeSet.probes

function jsonResponse (payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function sseResponse () {
  const body = new ReadableStream({
    start (controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{}}]}\n\n'))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function stubFetch (options = {}) {
  const sessions = new Set()
  let calls = 0
  const impl = async (url, init) => {
    calls += 1
    const headers = new Headers(init.headers)
    sessions.add(headers.get('x-opencode-session'))
    if (options.fail === true) return new Response('{"error":{"message":"stub failure"}}', { status: 400 })
    const body = JSON.parse(init.body)
    if (body.stream === true) return sseResponse()
    const isL = body.logprobs === true
    const prompt = String(body.messages?.[0]?.content ?? '')
    const glitchToken = prompt.startsWith('Repeat exactly, no explanation: ')
      ? prompt.slice('Repeat exactly, no explanation: '.length)
      : 'SetSavedPoint'
    return jsonResponse({
      id: 'chatcmpl-test-1',
      model: body.model,
      system_fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
      choices: [{
        message: { role: 'assistant', content: glitchToken },
        logprobs: isL ? { content: [{ token: 'We', logprob: -0.0004, top_logprobs: [{ token: 'We', logprob: -0.0004 }] }] } : null,
      }],
      usage: { prompt_tokens: 44, completion_tokens: 1, prompt_tokens_details: { cached_tokens: prompt.length > 1000 ? 1920 : 0 } },
    }, {
      'x-opencode-endpoint-id': 'endpoint-stub',
      'x-opencode-upstream-model-id': 'deepseek/deepseek-v4.1-flash',
      'x-opencode-log-id': 'log-stub-1',
    })
  }
  return { impl, sessions, calls: () => calls }
}

test('buildRequest：URL、会话头、max_tokens、thinking 与 logprobs 参数', () => {
  const provider = testConfig().provider
  const lProbe = probes.find((probe) => probe.group === 'L')
  const request = buildRequest({ provider, model: 'deepseek-v4.1-flash', probe: lProbe, sessionId: 'drift-1' })
  assert.equal(request.url, 'https://opencode.ai/inference/go/v1/chat/completions')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['x-opencode-session'], 'drift-1')
  assert.ok(request.headers.authorization.startsWith('Bearer '))
  assert.equal(request.body.model, 'deepseek-v4.1-flash')
  assert.equal(request.body.max_tokens, lProbe.maxTokens)
  assert.equal(request.body.thinking.type, 'disabled')
  assert.equal(request.body.logprobs, true)
  assert.equal(request.body.top_logprobs, 5)
})

test('C 组请求带上完整前缀 + 固定后缀', () => {
  const provider = testConfig().provider
  const cProbe = probes.find((probe) => probe.group === 'C')
  const request = buildRequest({ provider, model: 'm', probe: cProbe, sessionId: 'drift-c' })
  assert.ok(request.body.messages[0].content.length > 8000)
  assert.ok(request.body.messages[0].content.endsWith(' Reply with the single word OK.'))
})

test('会话 id 每轮唯一，且按 UTC 时间戳生成', () => {
  const timestamp = Date.parse('2026-10-18T00:00:00Z')
  const first = sessionIdFor('drift', timestamp, 0)
  const second = sessionIdFor('drift', timestamp, 1)
  assert.match(first, /^drift-20261018T000000Z-00$/u)
  assert.notEqual(first, second)
})

test('溯源头解析 + 响应 id 形态归类', () => {
  const headers = new Headers({
    'x-opencode-endpoint-id': 'endpoint-a',
    'x-opencode-upstream-model-id': 'deepseek/deepseek-v4.1-flash',
    'x-opencode-log-id': 'log-1',
    'cf-placement': 'remote-ORD',
    'cf-ray': 'ray-1',
  })
  const provenance = provenanceFromHeaders(headers, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')
  assert.equal(provenance.endpointId, 'endpoint-a')
  assert.equal(provenance.upstreamModelId, 'deepseek/deepseek-v4.1-flash')
  assert.equal(provenance.colo, 'remote-ORD')
  assert.equal(provenance.responseIdFamily, 'hex-native')
  assert.equal(provenanceFromHeaders(headers, 'chatcmpl-abc').responseIdFamily, 'chatcmpl')
  assert.equal(provenanceFromHeaders(headers, 'gw-123').responseIdFamily, 'gateway')
  assert.equal(provenanceFromHeaders(headers, '8f8d9b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b').responseIdFamily, 'uuid')
})

test('glitch 复述判定：去空白/引号后逐字符比较', () => {
  assert.equal(glitchReproduced('SetSavedPoint', 'SetSavedPoint'), true)
  assert.equal(glitchReproduced('SetSavedPoint', ' "SetSavedPoint" '), true)
  assert.equal(glitchReproduced('SetSavedPoint', 'Set Saved Point'), false)
  assert.equal(normalizeRepeat(' a\tb '), 'a b')
})

test('collect 端到端（桩 fetch）：写原始层、append-only、端点/会话/通道都记下来', async () => {
  const paths = await tempPaths()
  const config = testConfig({ collect: { sessions: 2, betweenProbesMs: 0 } })
  const stub = stubFetch()
  const result = await collect({
    config,
    paths,
    probes,
    probeSetHash,
    probeSetVersion: probeSet.probeSetVersion,
    fetchImpl: stub.impl,
    apiKey: 'test-key-not-a-secret',
  })
  assert.equal(result.requests, probes.reduce((sum, probe) => sum + probe.samples, 0) * 2)
  assert.equal(result.batches, 2)
  assert.equal(result.errors.length, 0)
  assert.deepEqual(result.endpointIds, ['endpoint-stub'])
  assert.equal(stub.sessions.size, 2, '两个会话必须是两个不同的会话 id')

  const lines = await readFile(result.rawFile, 'utf8')
  const batches = lines.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(batches.length, 2)
  const batch = batches[0]
  assert.equal(batch.probeSetHash, probeSetHash)
  assert.equal(batch.partial, false)
  assert.equal(batch.endpointId, 'endpoint-stub')
  assert.equal(batch.samples.length, probes.reduce((sum, probe) => sum + probe.samples, 0))
  const gSample = batch.samples.find((sample) => sample.group === 'G')
  assert.equal(gSample.channels.G.success, true)
  const cSamples = batch.samples.filter((sample) => sample.group === 'C')
  assert.deepEqual(cSamples.map((sample) => sample.channels.C.phase), ['first', 'second'])
  assert.equal(cSamples[1].channels.C.cachedTokens, 1920)
  // 官方端点的承诺通道要进原始层，供「检查点↔行为模板」绑定取证。
  const nonStreamSamples = batch.samples.filter((sample) => sample.group !== 'S')
  assert.ok(nonStreamSamples.every((sample) => sample.fingerprint === 'e72d3c7f663d3e1383b00b3884cb4501'), '每个非流式样本都应带 system_fingerprint')
  assert.equal(batch.samples.find((sample) => sample.group === 'S').fingerprint, null, '流式样本不解析正文，fingerprint 应为 null')

  // 再跑一轮：只追加，不改写历史
  const second = await collect({
    config,
    paths,
    probes,
    probeSetHash,
    probeSetVersion: probeSet.probeSetVersion,
    fetchImpl: stubFetch().impl,
    apiKey: 'test-key-not-a-secret',
  })
  assert.equal(second.rawFile, result.rawFile, '同一天应写同一个分卷')
  const after = (await readFile(result.rawFile, 'utf8')).trim().split('\n')
  assert.equal(after.length, 4)
})

test('官方端点：prompt_cache_hit_tokens 计入 C 通道（字段名与网关不同）', async () => {
  const paths = await tempPaths()
  const config = testConfig({ collect: { sessions: 1, betweenProbesMs: 0 } })
  const cProbes = probes.filter((probe) => probe.group === 'C')
  let call = 0
  const fetchImpl = async () => {
    call += 1
    return jsonResponse({
      id: 'chatcmpl-official-1',
      model: 'deepseek-flash',
      system_fingerprint: 'e72d3c7f663d3e1383b00b3884cb4501',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      // 官方端点口径：顶层 prompt_cache_hit_tokens，而不是 prompt_tokens_details.cached_tokens
      usage: { prompt_tokens: 1584, completion_tokens: 1, prompt_cache_hit_tokens: call === 1 ? 0 : 1408 },
    })
  }
  const result = await collect({
    config,
    paths,
    probes: cProbes,
    probeSetHash,
    probeSetVersion: probeSet.probeSetVersion,
    fetchImpl,
    apiKey: 'test-key-not-a-secret',
  })
  assert.equal(result.errors.length, 0)
  const lines = await readFile(result.rawFile, 'utf8')
  const batch = JSON.parse(lines.trim().split('\n').pop())
  const cSamples = batch.samples.filter((sample) => sample.group === 'C')
  assert.deepEqual(cSamples.map((sample) => sample.channels.C.cachedTokens), [0, 1408])
  assert.equal(batch.endpointId, 'direct:opencode-test', '无网关溯源头时用合成直连端点 id，保证可进基线')
  assert.deepEqual(cSamples.map((sample) => sample.fingerprint), ['e72d3c7f663d3e1383b00b3884cb4501', 'e72d3c7f663d3e1383b00b3884cb4501'])
})

test('collect：partial 批次标明只跑了哪些组', async () => {
  const paths = await tempPaths()
  const config = testConfig({ collect: { sessions: 1 } })
  const result = await collect({
    config,
    paths,
    probes,
    probeSetHash,
    probeSetVersion: probeSet.probeSetVersion,
    groups: ['T'],
    fetchImpl: stubFetch().impl,
    apiKey: 'test-key',
  })
  const batch = JSON.parse((await readFile(result.rawFile, 'utf8')).trim())
  assert.equal(batch.partial, true)
  assert.deepEqual(batch.probeIds, probes.filter((probe) => probe.group === 'T').map((probe) => probe.probeId))
  assert.equal(result.errors.length, 0)
})

test('collect：请求失败记成 sample.error，不中断整批', async () => {
  const paths = await tempPaths()
  const config = testConfig({ collect: { sessions: 1 } })
  const result = await collect({
    config,
    paths,
    probes,
    probeSetHash,
    probeSetVersion: probeSet.probeSetVersion,
    fetchImpl: stubFetch({ fail: true }).impl,
    apiKey: 'test-key',
  })
  assert.equal(result.errors.length, result.requests)
  assert.match(result.errors[0].message, /stub failure/u)
})

test('collect：dry-run 不发请求，也不需要 key', async () => {
  const paths = await tempPaths()
  const config = testConfig()
  const result = await collect({
    config,
    paths,
    probes,
    probeSetHash,
    dryRun: true,
    apiKey: undefined,
  })
  assert.equal(result.dryRun, true)
  assert.ok(result.plannedRequests > 0)
  assert.equal(result.firstRequest.headers['x-opencode-session'].startsWith('drift-dry-run'), true)
})
