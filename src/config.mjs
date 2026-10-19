// driftmon · 配置
//
// 配置只描述「连哪个路由、探多大、判多严」，不存 key（key 走环境变量名）。
// 默认值可直接跑 opencode-go；换成别的 OpenAI 兼容路由时只需要改 provider 段。

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PACKAGE_ROOT } from './paths.mjs'
import { GRAY_DEFAULT_THRESHOLDS } from './gray.mjs'

export const DEFAULT_CONFIG = {
  paths: { data: 'data', results: 'results', probes: 'probes' },
  plugin: {
    // dsh-system-fingerprint 的产物目录（只读依赖，契约见 docs/DEPENDENCY.md）
    dshHome: null,
    storageSubdir: 'storages/system-fingerprint',
  },
  provider: {
    id: 'opencode-go',
    api: 'openai-completions',
    // baseURL 只到 /v1 为止（请求拼 /chat/completions），不以 /completions 结尾。
    // 该值取自 pi-ai 目录里 opencode-go / deepseek-v4.1-flash 的 baseUrl；
    // 另一个可用的网关入口是 https://opencode.ai/zen/go/v1。
    baseURL: 'https://opencode.ai/inference/go/v1',
    model: 'deepseek-v4.1-flash',
    apiKeyEnv: 'OPENCODE_API_KEY',
    sessionHeader: 'x-opencode-session',
    headers: {
      'user-agent': 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)',
    },
    timeoutMs: 30000,
    retries: 1,
  },
  collect: {
    sessions: 8,
    // 同一会话内探针之间的间隔（毫秒）；0 = 不等待
    betweenProbesMs: 0,
    sessionPrefix: 'drift',
  },
  baseline: {
    windowBatches: 30,
  },
  gray: {
    // 「已知检查点模板」对比阈值（Phase 0 标定后按噪声底替换）
    thresholds: { ...GRAY_DEFAULT_THRESHOLDS },
  },
  judge: {
    nMin: 30,
    windowBatches: 30,
    // 阈值都是「Phase 0 标定前的默认值」，标定后按 noise-floor 替换（见 docs/ROADMAP.md）
    thresholds: {
      lMaxTopKJaccardDrop: 0.05, // 本批 top-k 重合度比基线 p50 低多少算异常
      lLogprobIqrZ: 2, // |中位数偏移| / 基线 iqr 超过多少算异常
      gZScore: 2, // G 组失败率的二项检验 z 阈值
      cHitRatioDrop: 0.2, // cache 命中率相对基线 p50 的下降阈值
      sTtftRatio: 1.5, // TTFT 中位数 / 基线 p95 超过多少算异常
    },
    // 至少几个独立通道同向才允许升级为 drift-candidate
    minIndependentChannels: 2,
    confirmRounds: 2,
  },
}

function deepMerge (base, extra) {
  if (extra === undefined || extra === null) return base
  if (Array.isArray(base) || typeof base !== 'object' || typeof extra !== 'object') return extra
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    out[key] = key in base ? deepMerge(base[key], value) : value
  }
  return out
}

/**
 * 找到配置来源：显式 --config > $DRIFTMON_CONFIG > driftmon/config.json > 内置默认。
 * @param {string|undefined} explicitPath
 */
export function findConfigPath (explicitPath) {
  if (explicitPath !== undefined) return resolve(explicitPath)
  if (process.env.DRIFTMON_CONFIG !== undefined && process.env.DRIFTMON_CONFIG !== '') return resolve(process.env.DRIFTMON_CONFIG)
  const local = join(PACKAGE_ROOT, 'config.json')
  return existsSync(local) ? local : undefined
}

/** 把 OpenAI 兼容 baseURL 补成 chat/completions 完整 URL（拒绝已带 /completions 的写法）。 */
export function chatCompletionsUrl (baseURL) {
  const trimmed = String(baseURL).replace(/\/+$/u, '')
  if (/\/completions$/u.test(trimmed)) {
    throw new Error(`baseURL 不能以 /completions 结尾（应只到 /v1）：${baseURL}`)
  }
  return `${trimmed}/chat/completions`
}

export function resolveDshHome (config) {
  const fromEnv = process.env.DSH_HOME
  if (config.plugin.dshHome !== null && config.plugin.dshHome !== undefined) {
    return resolve(PACKAGE_ROOT, config.plugin.dshHome)
  }
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  // 两个仓库并排时最常见的布局：<workspace>/home 与 <workspace>/driftmon
  return resolve(PACKAGE_ROOT, '..', 'home')
}

export function pluginStorageDir (config) {
  return join(resolveDshHome(config), config.plugin.storageSubdir)
}

/**
 * 加载配置。
 * @param {{configPath?: string, overrides?: object}} options
 */
export async function loadConfig (options = {}) {
  const configPath = findConfigPath(options.configPath)
  let fileConfig
  if (configPath !== undefined) {
    const text = await readFile(configPath, 'utf8')
    try {
      fileConfig = JSON.parse(text)
    } catch (error) {
      throw new Error(`${configPath} 不是合法 JSON：${error.message}`)
    }
  }
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), options.overrides)
  merged.paths = {
    data: merged.paths.data,
    results: merged.paths.results,
    probes: merged.paths.probes,
  }
  merged.provider.timeoutMs = positiveInt(merged.provider.timeoutMs, DEFAULT_CONFIG.provider.timeoutMs)
  merged.provider.retries = nonNegativeInt(merged.provider.retries, DEFAULT_CONFIG.provider.retries)
  merged.collect.sessions = positiveInt(merged.collect.sessions, DEFAULT_CONFIG.collect.sessions)
  return { config: merged, configPath }
}

function positiveInt (value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function nonNegativeInt (value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}
