// driftmon · 被动层依赖（dsh-system-fingerprint 的产物）
//
// 两个仓库、只读文件契约（docs/DEPENDENCY.md）：
//   driftmon 不 import 插件代码，只读取 $DSH_HOME/storages/system-fingerprint/ 下的：
//     * endpoints.json（v1，必需）：端点登记表；
//     * config.json（v1，可选）：provider / 开关 / 网关映射 / 最近检查点的只读导出。
//   契约版本 = 文件的 version 字段；读到不认识的版本只告警、不崩，继续用已知字段。
//   插件不知道 driftmon 存在；缺失这两个文件时 driftmon 的主动探针照常工作。
//
// 这个模块是 driftmon 里唯一允许碰插件目录的地方。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SUPPORTED_ENDPOINTS_SCHEMA_VERSION = 1
export const SUPPORTED_CONFIG_SCHEMA_VERSION = 1

function isRecord (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读取被动层端点登记表。
 * @param {string} storageDir - $DSH_HOME/storages/system-fingerprint
 * @returns {Promise<{found:boolean,path:string,error?:string,warnings:string[],version?:number,updatedAt?:number,endpoints:Array<object>,byId:Map<string,object>,models:Set<string>}>}
 */
export async function loadPluginDependency (storageDir) {
  const path = join(storageDir, 'endpoints.json')
  const result = {
    found: false,
    path,
    error: undefined,
    warnings: [],
    version: undefined,
    updatedAt: undefined,
    endpoints: [],
    byId: new Map(),
    models: new Set(),
  }
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    result.error = error.code === 'ENOENT' ? 'endpoints.json 不存在（插件未安装或还没拦到真实响应）' : error.message
    return result
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    result.error = `endpoints.json 不是合法 JSON：${error.message}`
    return result
  }
  result.found = true
  result.version = parsed.version
  result.updatedAt = parsed.updatedAt
  if (parsed.version !== SUPPORTED_ENDPOINTS_SCHEMA_VERSION) {
    result.warnings.push(`endpoints.json 版本 ${String(parsed.version)} 与 driftmon 支持的 v${SUPPORTED_ENDPOINTS_SCHEMA_VERSION} 不一致；只读已知字段`)
  }
  const endpoints = parsed.endpoints !== null && typeof parsed.endpoints === 'object' ? parsed.endpoints : {}
  for (const [id, entry] of Object.entries(endpoints)) {
    if (entry === null || typeof entry !== 'object') continue
    const models = entry.models !== null && typeof entry.models === 'object' ? Object.keys(entry.models) : []
    const row = {
      endpointId: typeof entry.endpointId === 'string' && entry.endpointId.length > 0 ? entry.endpointId : id,
      counted: Number.isInteger(entry.count) ? entry.count : 0,
      firstSeenAt: typeof entry.firstSeenAt === 'number' ? entry.firstSeenAt : null,
      lastSeenAt: typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : null,
      models,
      sources: entry.sources ?? {},
      lastContext: entry.lastContext ?? null,
    }
    result.endpoints.push(row)
    result.byId.set(row.endpointId, row)
    for (const model of models) result.models.add(model)
  }
  return result
}

/**
 * 读取被动层只读配置导出 config.json（可选消费）。
 *
 * 缺失 / 损坏 / 版本不认识都不影响采集：返回 found=false 或 warnings，不抛错。
 * 用途：对齐探测路由（provider/model/baseURL）；把「行为模板」绑定到最近一次探测到的检查点。
 *
 * @param {string} storageDir - $DSH_HOME/storages/system-fingerprint
 * @returns {Promise<{found:boolean,path:string,error?:string,warnings:string[],version?:number,updatedAt?:number,plugin:object|null,probe:object|null,capture:object|null,gateway:object|null,checkpoints:Array<object>,checkpoint:object|null}>}
 */
export async function loadPluginConfig (storageDir) {
  const path = join(storageDir, 'config.json')
  const result = {
    found: false,
    path,
    error: undefined,
    warnings: [],
    version: undefined,
    updatedAt: undefined,
    plugin: null,
    probe: null,
    capture: null,
    gateway: null,
    checkpoints: [],
    checkpoint: null,
  }
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    result.error = error.code === 'ENOENT'
      ? 'config.json 不存在（插件未安装，或还是未导出该文件的旧版本）'
      : error.message
    return result
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    result.error = `config.json 不是合法 JSON：${error.message}`
    return result
  }
  if (!isRecord(parsed)) {
    result.error = 'config.json 顶层不是对象'
    return result
  }
  result.found = true
  result.version = parsed.version
  result.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined
  if (parsed.version !== SUPPORTED_CONFIG_SCHEMA_VERSION) {
    result.warnings.push(`config.json 版本 ${String(parsed.version)} 与 driftmon 支持的 v${SUPPORTED_CONFIG_SCHEMA_VERSION} 不一致；只读已知字段`)
  }
  result.plugin = isRecord(parsed.plugin) ? parsed.plugin : null
  result.probe = isRecord(parsed.probe) ? parsed.probe : null
  result.capture = isRecord(parsed.capture) ? parsed.capture : null
  result.gateway = isRecord(parsed.gateway) ? parsed.gateway : null
  if (Array.isArray(parsed.checkpoints)) {
    result.checkpoints = parsed.checkpoints
      .filter((entry) => isRecord(entry) && typeof entry.fingerprint === 'string')
      .map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : null,
        fingerprint: entry.fingerprint,
      }))
  }
  if (isRecord(parsed.checkpoint) && typeof parsed.checkpoint.fingerprint === 'string') {
    const checkpoint = parsed.checkpoint
    result.checkpoint = {
      fingerprint: checkpoint.fingerprint,
      name: typeof checkpoint.name === 'string' ? checkpoint.name : null,
      provider: typeof checkpoint.provider === 'string' ? checkpoint.provider : null,
      model: typeof checkpoint.model === 'string' ? checkpoint.model : null,
      probedAt: typeof checkpoint.probedAt === 'number' ? checkpoint.probedAt : null,
      endpointHost: typeof checkpoint.endpointHost === 'string' ? checkpoint.endpointHost : null,
      confidence: typeof checkpoint.confidence === 'string' ? checkpoint.confidence : null,
    }
  }
  return result
}

/** 某个端点 id 是否在被动层登记过（用于报告里的「已登记/未登记」标注）。 */
export function describeEndpoint (dependency, endpointId) {
  if (!dependency?.found || endpointId === null || endpointId === undefined) return { registered: false }
  const hit = dependency.byId.get(endpointId)
  if (hit === undefined) return { registered: false, knownCount: dependency.endpoints.length }
  return {
    registered: true,
    models: hit.models,
    lastSeenAt: hit.lastSeenAt,
    counted: hit.counted,
    lastContext: hit.lastContext,
  }
}
