// driftmon · 采集器
//
// 一次采集 = 「一轮巡检」：K 个新会话 × 每个会话发一遍冻结探针组。
// 之所以必须换会话 id，是因为网关路由按会话绑定（docs/PREREQUISITES.md §2.3）：
// 同一个会话连打 40 分钟也可能一次不换端点，单会话采样看不到其他后端。
//
// 输出只进原始层（data/raw/YYYY-MM-DD.jsonl，append-only）：
//   * 不存 prompt 原文、不存响应正文；
//   * G 组只存「是否原样复述」布尔位图与输出长度；
//   * L 组存被采样 token 串与概率数组（它们是数值签名的标签，属数值摘要）。

import { appendRawBatch, rawFileFor } from './paths.mjs'
import { chatCompletionsUrl } from './config.mjs'

const GROUP_ORDER = ['T', 'L', 'G', 'C', 'S']

/**
 * 归一化后比较「原样复述」：去首尾引号/反引号、把内部空白折叠成单个空格、去首尾空白。
 * 注意不能把空白全部删掉——那会让「Set Saved Point」和 token「SetSavedPoint」判成相同（实测踩过）。
 */
export function normalizeRepeat (text) {
  if (typeof text !== 'string') return ''
  return text
    .trim()
    .replace(/^[`"'“”『「]+/u, '')
    .replace(/[`"'“”』」]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function glitchReproduced (token, output) {
  return normalizeRepeat(output) === normalizeRepeat(token) && normalizeRepeat(token).length > 0
}

export function sessionIdFor (prefix, timestamp, index) {
  const stamp = new Date(timestamp).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return `${prefix}-${stamp}-${String(index).padStart(2, '0')}`
}

/** 构造一次探针请求（纯函数，测试直接断言）。 */
export function buildRequest ({ provider, model, probe, sessionId }) {
  const headers = {
    authorization: 'Bearer <redacted>',
    'content-type': 'application/json',
    accept: probe.params.stream === true ? 'text/event-stream' : 'application/json',
  }
  if (typeof provider.sessionHeader === 'string' && provider.sessionHeader.length > 0) {
    headers[provider.sessionHeader] = sessionId
  }
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    headers[name.toLowerCase()] = String(value)
  }
  const body = {
    model,
    messages: [{ role: 'user', content: probe.promptResolved }],
    max_tokens: probe.maxTokens,
    ...probe.params,
  }
  return {
    url: chatCompletionsUrl(provider.baseURL),
    method: 'POST',
    headers,
    body,
    stream: probe.params.stream === true,
  }
}

/** 从响应头抽网关溯源字段（与插件实现同口径，见 docs/PREREQUISITES.md §1）。 */
export function provenanceFromHeaders (headers, responseId) {
  const get = (name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name]) ?? null
  const rawId = typeof responseId === 'string' ? responseId : ''
  let responseIdFamily = 'other'
  if (/^[0-9a-f]{32,}$/u.test(rawId)) responseIdFamily = 'hex-native'
  else if (/^gw[-_]/u.test(rawId)) responseIdFamily = 'gateway'
  else if (/^chatcmpl[-_]/u.test(rawId)) responseIdFamily = 'chatcmpl'
  else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(rawId)) responseIdFamily = 'uuid'
  return {
    endpointId: get('x-opencode-endpoint-id'),
    upstreamModelId: get('x-opencode-upstream-model-id'),
    logId: get('x-opencode-log-id'),
    zenModel: get('x-zen-model'),
    colo: get('cf-placement'),
    rayId: get('cf-ray'),
    traceId: get('x-opencode-log-id') ?? get('x-ds-trace-id') ?? get('x-request-id') ?? null,
    responseIdFamily,
    responseId: rawId === '' ? null : rawId,
  }
}

function usageOf (body) {
  const usage = body !== null && typeof body === 'object' ? body.usage : undefined
  if (usage === null || typeof usage !== 'object') return { promptTokens: null, completionTokens: null, cachedTokens: null, reasoningTokens: null }
  const details = usage.prompt_tokens_details ?? {}
  // 官方 DeepSeek 用 prompt_cache_hit_tokens，OpenAI 兼容网关用 prompt_tokens_details.cached_tokens（见 docs/PREREQUISITES.md §1）。
  const cachedRaw = details.cached_tokens ?? usage.prompt_cache_hit_tokens
  return {
    promptTokens: Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : null,
    completionTokens: Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : null,
    cachedTokens: Number.isInteger(cachedRaw) ? cachedRaw : null,
    reasoningTokens: Number.isInteger(usage.completion_tokens_details?.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : null,
  }
}

function contentOf (body) {
  const choice = body !== null && typeof body === 'object' && Array.isArray(body.choices) ? body.choices[0] : undefined
  const message = choice?.message
  if (message === null || typeof message !== 'object') return ''
  return typeof message.content === 'string' ? message.content : ''
}

function logprobsOf (body) {
  const choice = body !== null && typeof body === 'object' && Array.isArray(body.choices) ? body.choices[0] : undefined
  const content = choice?.logprobs?.content
  if (!Array.isArray(content)) return { tokens: [], logprobs: [], topK: [] }
  return {
    tokens: content.map((entry) => (typeof entry?.token === 'string' ? entry.token : '')),
    logprobs: content.map((entry) => (typeof entry?.logprob === 'number' ? entry.logprob : null)),
    topK: content.map((entry) => (Array.isArray(entry?.top_logprobs)
      ? entry.top_logprobs.map((alt) => (typeof alt?.token === 'string' ? alt.token : '')).filter((token) => token !== '')
      : [])),
  }
}

function errorMessageOf (text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 300)
      if (typeof parsed.message === 'string') return parsed.message.slice(0, 300)
    }
  } catch { /* 非 JSON 错误体 */ }
  return String(text ?? '').slice(0, 300)
}

async function readErrorBody (response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

async function readStreamTiming (response, requestStartedAt) {
  const startedAt = requestStartedAt ?? Date.now()
  let ttftMs = null
  let bytes = 0
  const reader = response.body?.getReader()
  if (!reader) return { ttftMs: Date.now() - startedAt, totalMs: Date.now() - startedAt, bytes }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined && value.byteLength > 0) {
        bytes += value.byteLength
        if (ttftMs === null) ttftMs = Date.now() - startedAt
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* 已结束 */ }
  }
  return { ttftMs: ttftMs ?? Date.now() - startedAt, totalMs: Date.now() - startedAt, bytes }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 发一个探针请求并解析成 channel 数据。
 * @returns {Promise<{ok:boolean, status:number, at:number, channels:object, provenance:object, usage:object, error?:object}>}
 */
async function probeOnce ({ request, apiKey, probe, fetchImpl, timeoutMs, retries }) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now()
    const headers = { ...request.headers, authorization: `Bearer ${apiKey}` }
    let response
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      lastError = { code: 'network', message: error instanceof Error ? error.message : String(error) }
      if (attempt < retries) { await sleep(300); continue }
      return { ok: false, status: 0, at: startedAt, channels: {}, provenance: {}, usage: {}, error: lastError }
    }
    if (request.stream) {
      if (!response.ok) {
        const text = await readErrorBody(response)
        lastError = { code: 'http', status: response.status, message: errorMessageOf(text) }
        if (response.status >= 500 && attempt < retries) { await sleep(300); continue }
        return { ok: false, status: response.status, at: startedAt, channels: {}, provenance: provenanceFromHeaders(response.headers), usage: {}, error: lastError }
      }
      const timing = await readStreamTiming(response, startedAt)
      return {
        ok: true,
        status: response.status,
        at: startedAt,
        channels: { S: { probeId: probe.probeId, ttftMs: timing.ttftMs, totalMs: timing.totalMs } },
        provenance: provenanceFromHeaders(response.headers),
        usage: {},
      }
    }
    const text = await readErrorBody(response)
    if (!response.ok) {
      lastError = { code: 'http', status: response.status, message: errorMessageOf(text) }
      if ((response.status >= 500 || response.status === 429) && attempt < retries) { await sleep(300); continue }
      return { ok: false, status: response.status, at: startedAt, channels: {}, provenance: provenanceFromHeaders(response.headers), usage: {}, error: lastError }
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        at: startedAt,
        channels: {},
        provenance: provenanceFromHeaders(response.headers),
        usage: {},
        error: { code: 'invalid-json', message: error instanceof Error ? error.message : String(error) },
      }
    }
    const usage = usageOf(body)
    const provenance = provenanceFromHeaders(response.headers, body?.id)
    const channels = channelsOfProbe({ probe, body, usage })
    // 官方端点会回 system_fingerprint（网关不会）；存进原始层，供「检查点↔行为模板」绑定取证。
    const fingerprint = typeof body?.system_fingerprint === 'string' && body.system_fingerprint.length > 0
      ? body.system_fingerprint
      : null
    return { ok: true, status: response.status, at: startedAt, channels, provenance, usage, fingerprint }
  }
  return { ok: false, status: 0, at: Date.now(), channels: {}, provenance: {}, usage: {}, error: lastError ?? { code: 'unknown', message: 'unreachable' } }
}

function channelsOfProbe ({ probe, body, usage }) {
  if (probe.group === 'T') {
    return { T: { probeId: probe.probeId, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } }
  }
  if (probe.group === 'L') {
    const logprobs = logprobsOf(body)
    return {
      L: {
        probeId: probe.probeId,
        tokens: logprobs.tokens,
        logprobs: logprobs.logprobs,
        topK: logprobs.topK,
        outputLength: contentOf(body).length,
      },
    }
  }
  if (probe.group === 'G') {
    const output = contentOf(body)
    return {
      G: {
        probeId: probe.probeId,
        token: probe.glitchToken ?? null,
        success: probe.glitchToken === undefined ? false : glitchReproduced(probe.glitchToken, output),
        outputLength: output.length,
      },
    }
  }
  if (probe.group === 'C') {
    return {
      C: {
        probeId: probe.probeId,
        phase: probe.cPhase ?? 'first',
        prefixTokens: probe.prefixTokens,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
      },
    }
  }
  if (probe.group === 'S') {
    return { S: { probeId: probe.probeId, ttftMs: null, totalMs: null } }
  }
  return {}
}

function modeOf (values) {
  const counts = new Map()
  for (const value of values) {
    if (value === null || value === undefined) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  let best = null
  let bestCount = -1
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count }
  }
  return best
}

/**
 * 跑一轮巡检。
 * @param {object} options
 * @param {object} options.config
 * @param {Array<object>} options.probes - 已展开的探针（含 promptResolved；G 组含 glitchToken）
 * @param {string} options.probeSetHash
 * @param {number} [options.sessions]
 * @param {string[]} [options.groups] - 只跑指定组（冒烟用；出来的批次标 partial=true）
 * @param {boolean} [options.dryRun]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.now]
 * @param {(line:string)=>void} [options.log]
 */
export async function collect (options) {
  const { config, probeSetHash, probes } = options
  const provider = config.provider
  const groups = options.groups
  const selected = groups === undefined || groups === null || groups.length === 0
    ? probes
    : probes.filter((probe) => new Set(groups).has(probe.group))
  if (selected.length === 0) throw new Error(`没有匹配的探针：groups=${JSON.stringify(groups)}`)
  const partial = selected.length !== probes.length
  const sessions = options.sessions ?? config.collect.sessions
  const now = options.now ?? Date.now()
  const log = options.log ?? (() => {})
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const apiKey = options.apiKey ?? process.env[provider.apiKeyEnv]
  const plannedRequests = selected.reduce((sum, probe) => sum + probe.samples, 0) * sessions

  if (options.dryRun === true) {
    const first = selected[0]
    const request = buildRequest({ provider, model: provider.model, probe: first, sessionId: 'drift-dry-run-00' })
    return { dryRun: true, sessions, partial, plannedRequests, firstRequest: { ...request, headers: { ...request.headers, authorization: 'Bearer <redacted>' } }, probeSetHash }
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error(`缺少凭据：环境变量 ${provider.apiKeyEnv} 未设置（key 不进配置文件）`)
  }

  const ordered = [...selected].sort((a, b) => matchGroupOrder(a.group) - matchGroupOrder(b.group))
  const batches = []
  const errors = []
  const endpointIds = new Set()
  let requests = 0
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  const startedAt = now

  for (let index = 0; index < sessions; index += 1) {
    const sessionId = sessionIdFor(config.collect.sessionPrefix, now, index)
    const samples = []
    const batchStartedAt = Date.now()
    for (const probe of ordered) {
      const samplesOfProbe = probe.samples
      for (let sampleIndex = 0; sampleIndex < samplesOfProbe; sampleIndex += 1) {
        const effective = probe.group === 'C' ? { ...probe, cPhase: sampleIndex === 0 ? 'first' : 'second' } : probe
        const request = buildRequest({ provider, model: provider.model, probe: effective, sessionId })
        const result = await probeOnce({
          request,
          apiKey,
          probe: effective,
          fetchImpl,
          timeoutMs: provider.timeoutMs,
          retries: provider.retries,
        })
        requests += 1
        if (probe.group === 'S' && result.channels.S && result.channels.S.ttftMs === null) {
          result.channels.S = undefined
        }
        const sample = {
          sampleId: `${sessionId}-${probe.probeId}-${sampleIndex}`,
          session: sessionId,
          at: result.at,
          status: result.status,
          group: probe.group,
          probeId: probe.probeId,
          provenance: result.provenance,
          usage: result.usage,
          channels: result.channels,
          fingerprint: result.fingerprint ?? null,
        }
        if (result.error !== undefined) {
          sample.error = result.error
          errors.push({ session: sessionId, probeId: probe.probeId, ...result.error })
        }
        if (result.provenance.endpointId !== null && result.provenance.endpointId !== undefined) endpointIds.add(result.provenance.endpointId)
        if (Number.isInteger(result.usage.promptTokens)) promptTokens += result.usage.promptTokens
        if (Number.isInteger(result.usage.completionTokens)) completionTokens += result.usage.completionTokens
        if (Number.isInteger(result.usage.cachedTokens)) cachedTokens += result.usage.cachedTokens
        samples.push(sample)
        if (config.collect.betweenProbesMs > 0) await sleep(config.collect.betweenProbesMs)
      }
    }
    // 官方直连端点没有 x-opencode-endpoint-id 之类的网关溯源头：给它一个稳定的合成端点 id，
    // 否则这类批次会被 isComparableBatch 排除，官方路由就永远进不了基线/判定。
    const directEndpointId = `direct:${provider.id}`
    const batch = {
      batchId: `${new Date(batchStartedAt).toISOString().slice(0, 19).replace(/[-:]/gu, '')}Z-${String(index + 1).padStart(2, '0')}`,
      probeSetHash,
      probeSetVersion: options.probeSetVersion ?? null,
      partial,
      probeIds: partial ? ordered.map((probe) => probe.probeId) : undefined,
      at: batchStartedAt,
      provider: provider.id,
      model: provider.model,
      api: provider.api,
      endpointId: modeOf(samples.map((sample) => sample.provenance.endpointId)) ?? directEndpointId,
      samples,
    }
    batches.push(batch)
    log(`  会话 ${String(index + 1).padStart(2, '0')}/${sessions}：${samples.filter((sample) => sample.error === undefined).length}/${samples.length} 成功 · endpoint=${batch.endpointId ?? 'unknown'}`)
  }

  const rawFile = rawFileFor(options.paths, startedAt)
  for (const batch of batches) await appendRawBatch(rawFile, batch)
  return {
    dryRun: false,
    rawFile,
    sessions,
    partial,
    batches: batches.length,
    requests,
    plannedRequests,
    samples: batches.reduce((sum, batch) => sum + batch.samples.length, 0),
    errors,
    endpointIds: [...endpointIds],
    usage: { promptTokens, completionTokens, cachedTokens, totalTokens: promptTokens + completionTokens },
    durationMs: Date.now() - startedAt,
  }
}

function matchGroupOrder (group) {
  const index = GROUP_ORDER.indexOf(group)
  return index === -1 ? GROUP_ORDER.length : index
}
