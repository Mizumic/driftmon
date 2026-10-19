// 测试辅助：构造原始层批次 / 配置 / 临时目录。
// 不联网、不读真实凭据；原始批次按 DATA-MODEL 的字段形状造假数据。

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config.mjs'
import { loadProbeSet } from '../src/probe-set.mjs'

export const TEST_PROBES_DIR = new URL('../probes/', import.meta.url).pathname
export const TEST_HASH = 'sha256:test-probe-set'

let cached

/** 真实冻结探针组（只读；测试用它保证字段形状与线上一致）。 */
export async function testProbes () {
  if (cached === undefined) cached = loadProbeSet(TEST_PROBES_DIR)
  return cached
}

export function testConfig (overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    provider: { ...DEFAULT_CONFIG.provider, id: 'opencode-test', model: 'test-model', ...overrides.provider },
    judge: { ...DEFAULT_CONFIG.judge, ...overrides.judge },
    baseline: { ...DEFAULT_CONFIG.baseline, ...overrides.baseline },
    collect: { ...DEFAULT_CONFIG.collect, ...overrides.collect },
  }
}

export async function tempPaths () {
  const root = await mkdtemp(join(tmpdir(), 'driftmon-test-'))
  return {
    root,
    raw: join(root, 'raw'),
    baselines: join(root, 'baselines'),
    alerts: join(root, 'alerts'),
    reports: join(root, 'reports'),
  }
}

function lSamples (probes, lProfile) {
  const lProbe = probes.find((probe) => probe.group === 'L')
  const sequences = lProfile.sequences ?? [['We', ' need', ' answer'], ['We', ' need', ' answer']]
  const logprobs = lProfile.logprobs ?? [-0.0004, -0.0004, -0.0004]
  const topK = lProfile.topK ?? [['We', 'The'], [' need', 'Answer'], [' answer', ' answer']]
  return Array.from({ length: lProbe.samples }, (_, index) => ({
    sampleId: `sess-l-${index}`,
    session: 'sess',
    at: 1,
    status: 200,
    group: 'L',
    probeId: lProbe.probeId,
    provenance: {},
    usage: {},
    channels: { L: { probeId: lProbe.probeId, tokens: sequences[index % sequences.length], logprobs, topK, outputLength: 8 } },
  }))
}

function gSamples (probes, gFailCount) {
  const gProbes = probes.filter((probe) => probe.group === 'G')
  return gProbes.map((probe, index) => ({
    sampleId: `sess-g-${index}`,
    session: 'sess',
    at: 1,
    status: 200,
    group: 'G',
    probeId: probe.probeId,
    provenance: {},
    usage: {},
    channels: { G: { probeId: probe.probeId, token: probe.glitchToken, success: index >= gFailCount, outputLength: 4 } },
  }))
}

function cSamples (probes, cProfile) {
  const cProbe = probes.find((probe) => probe.group === 'C')
  const prefix = cProbe.prefixTokens ?? 2000
  const firstCached = cProfile.firstCached ?? 0
  const secondCached = cProfile.secondCached ?? Math.round(prefix * 0.96)
  return [
    {
      sampleId: 'sess-c-0', session: 'sess', at: 1, status: 200, group: 'C', probeId: cProbe.probeId, provenance: {}, usage: {},
      channels: { C: { probeId: cProbe.probeId, phase: 'first', prefixTokens: prefix, promptTokens: prefix + 10, cachedTokens: firstCached } },
    },
    {
      sampleId: 'sess-c-1', session: 'sess', at: 2, status: 200, group: 'C', probeId: cProbe.probeId, provenance: {}, usage: {},
      channels: { C: { probeId: cProbe.probeId, phase: 'second', prefixTokens: prefix, promptTokens: prefix + 10, cachedTokens: secondCached } },
    },
  ]
}

function sSamples (probes, ttft) {
  const sProbe = probes.find((probe) => probe.group === 'S')
  return Array.from({ length: sProbe.samples }, (_, index) => ({
    sampleId: `sess-s-${index}`, session: 'sess', at: 1, status: 200, group: 'S', probeId: sProbe.probeId, provenance: {}, usage: {},
    channels: { S: { probeId: sProbe.probeId, ttftMs: ttft + index * 7, totalMs: ttft + 200 } },
  }))
}

/**
 * 造一条原始批次。
 * @param {object} options
 * @param {Array<object>} options.probes
 * @param {number} options.at
 * @param {string} options.endpointId
 * @param {number[]} [options.tVector]
 * @param {number} [options.gFailCount]
 * @param {object} [options.lProfile]
 * @param {object} [options.cProfile]
 * @param {number} [options.ttft]
 */
export function makeBatch (options) {
  const probes = options.probes
  const tProbes = probes.filter((probe) => probe.group === 'T')
  const tVector = options.tVector ?? tProbes.map(() => 44)
  const tSamples = tProbes.map((probe, index) => ({
    sampleId: `sess-t-${index}`, session: 'sess', at: 1, status: 200, group: 'T', probeId: probe.probeId, provenance: {},
    usage: {},
    channels: { T: { probeId: probe.probeId, promptTokens: tVector[index], completionTokens: 1 } },
  }))
  const samples = [
    ...tSamples,
    ...lSamples(probes, options.lProfile ?? {}),
    ...gSamples(probes, options.gFailCount ?? 7),
    ...cSamples(probes, options.cProfile ?? {}),
    ...sSamples(probes, options.ttft ?? 800),
  ]
  return {
    batchId: `batch-${options.at}`,
    probeSetHash: options.probeSetHash ?? TEST_HASH,
    probeSetVersion: '0.1.0-phase0',
    partial: options.partial ?? false,
    at: options.at,
    provider: options.provider ?? 'opencode-test',
    model: options.model ?? 'test-model',
    api: 'openai-completions',
    endpointId: options.endpointId,
    samples,
  }
}

/** 造一串稳定批次。 */
export function makeStableBatches (probes, count, options = {}) {
  return Array.from({ length: count }, (_, index) => makeBatch({
    probes,
    at: (options.startAt ?? 1_000_000) + index * 60_000,
    endpointId: options.endpointId ?? 'endpoint-a',
    tVector: options.tVector,
    gFailCount: options.gFailCount,
    lProfile: options.lProfile,
    cProfile: options.cProfile,
    ttft: options.ttft,
    probeSetHash: options.probeSetHash,
  }))
}
