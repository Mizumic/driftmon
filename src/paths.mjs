// driftmon · 路径与存储原语
//
// 硬约束（docs/DATA-MODEL.md）：原始层 append-only —— 只追加、不改写、不删除。
// 这个文件把「写原始观测」收成一个入口，避免别处顺手用 writeFile 冲掉历史。

import { appendFile, mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** driftmon/ 根目录（本文件在 src/ 下）。 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function pathsOf (config) {
  const data = resolve(PACKAGE_ROOT, config.paths.data)
  const results = resolve(PACKAGE_ROOT, config.paths.results)
  const probes = resolve(PACKAGE_ROOT, config.paths.probes)
  return {
    packageRoot: PACKAGE_ROOT,
    data,
    results,
    probes,
    raw: join(data, 'raw'),
    baselines: join(data, 'baselines'),
    templates: join(data, 'templates'),
    alerts: join(results, 'alerts'),
    reports: join(results, 'reports'),
    watch: join(results, 'watch'),
  }
}

export async function ensureDirs (paths) {
  for (const dir of [paths.raw, paths.baselines, paths.templates, paths.alerts, paths.reports, paths.watch]) {
    await mkdir(dir, { recursive: true })
  }
}

/** 当日原始文件名（按 UTC 日期分卷；滚动分卷不删历史）。 */
export function rawFileFor (paths, timestamp) {
  const day = new Date(timestamp).toISOString().slice(0, 10)
  return join(paths.raw, `${day}.jsonl`)
}

/**
 * 追加一行 JSON 到原始层。唯一允许写原始层的入口。
 * @param {string} file - 目标文件（data/raw/YYYY-MM-DD.jsonl）
 * @param {object} record - 一条批次记录
 */
export async function appendRawBatch (file, record) {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(record) + '\n', 'utf8')
}

/** 列出全部原始分卷（按文件名排序 = 按时间排序）。 */
export async function listRawFiles (paths) {
  if (!existsSync(paths.raw)) return []
  const names = await readdir(paths.raw)
  return names.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)).sort().map((name) => join(paths.raw, name))
}

/**
 * 读取时给批次补一个稳定的端点分组键：早期/官方直连批次没有网关溯源
 * （endpointId=null），不补的话 `isComparableBatch` 会把它们全部排除，官方路由就进不了基线/判定。
 * 只影响内存里的读视图，不回写原始层。
 */
function withEndpointFallback (batch) {
  if (batch === null || typeof batch !== 'object') return batch
  if (typeof batch.endpointId === 'string' && batch.endpointId.length > 0) return batch
  const provider = typeof batch.provider === 'string' && batch.provider.length > 0 ? batch.provider : null
  if (provider === null) return batch
  return { ...batch, endpointId: `direct:${provider}` }
}

/** 读取全部原始批次（逐行解析；坏行直接报错，不静默跳过）。 */
export async function readAllRawBatches (paths) {
  const files = await listRawFiles(paths)
  const batches = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    let lineNo = 0
    for (const line of text.split('\n')) {
      lineNo += 1
      if (line.trim() === '') continue
      try {
        batches.push(withEndpointFallback(JSON.parse(line)))
      } catch (error) {
        throw new Error(`${file}:${lineNo} 不是合法 JSON：${error.message}`)
      }
    }
  }
  return batches
}

export async function readJsonFile (file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback
    throw error
  }
}

/** 原子写派生层/判定层文件（这些层可重建，允许整体替换）。 */
export async function writeJsonAtomic (file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

/** 文件名安全的别名（provider/model 可能含 / 或空格）。 */
export function safeName (value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, '_')
}

export function baselineFileFor (paths, provider, model) {
  return join(paths.baselines, `${safeName(provider)}--${safeName(model)}.json`)
}

export function alertFileFor (paths, at, provider, model) {
  const stamp = new Date(at).toISOString().replace(/[:.]/gu, '-')
  return join(paths.alerts, `${stamp}-${safeName(provider)}-${safeName(model)}.json`)
}

export function watchFileFor (paths) {
  return join(paths.watch, 'gray-watch.json')
}

/** Phase 0 噪声底（派生层，可重建；schema 见 docs/DATA-MODEL.md 层③）。 */
export function noiseFloorFileFor (paths) {
  return join(paths.baselines, 'noise-floor.json')
}

export function templateFileFor (paths, checkpointNameOrFingerprint) {
  return join(paths.templates, `checkpoint-${safeName(checkpointNameOrFingerprint)}.json`)
}

export function reportFileFor (paths, at, provider, model) {
  const day = new Date(at).toISOString().slice(0, 10)
  return join(paths.reports, `${day}-${safeName(provider)}-${safeName(model)}.md`)
}
