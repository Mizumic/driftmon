// driftmon · 探针组（冻结的配置层）
//
// 规则（probes/README.md）：
//   * 探针组一旦冻结，任何字段改动都必须换 probeSetVersion；旧基线与新基线并存；
//   * probeSetHash = sha256(规范化(probe-set.json))：排序对象键、保留 probeSetVersion、
//     去掉其它元数据、保留探针顺序与全部探针字段；
//   * C 组长前缀放在独立文件里，用 promptSha256 锁定字节，加载时校验。

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const GROUPS = new Set(['T', 'L', 'G', 'C', 'S'])
const REQUIRED_PROBE_FIELDS = ['probeId', 'group', 'maxTokens', 'samples', 'params']

/** 递归排序对象键（数组顺序保持不变）。 */
export function sortKeysDeep (value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key])
  return out
}

/** 规范形：只保留 probeSetVersion + probes，对象键排序，数组顺序不变。 */
export function canonicalProbeSet (probeSet) {
  return sortKeysDeep({
    probeSetVersion: probeSet.probeSetVersion,
    probes: probeSet.probes.map((probe) => {
      // 去掉纯说明性元数据（如有），保留全部探针字段
      const { description: _description, note: _note, ...fields } = probe
      return fields
    }),
  })
}

export function computeProbeSetHash (probeSet) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonicalProbeSet(probeSet)), 'utf8').digest('hex')
}

function assert (condition, message) {
  if (!condition) throw new Error(`probe-set 不合法：${message}`)
}

/**
 * 校验探针组结构。
 * @param {object} probeSet
 */
export function validateProbeSet (probeSet) {
  assert(probeSet && typeof probeSet === 'object', '顶层必须是对象')
  assert(typeof probeSet.probeSetVersion === 'string' && probeSet.probeSetVersion.length > 0, '缺少 probeSetVersion')
  assert(Array.isArray(probeSet.probes) && probeSet.probes.length > 0, 'probes 必须是非空数组')
  const ids = new Set()
  for (const probe of probeSet.probes) {
    for (const field of REQUIRED_PROBE_FIELDS) assert(probe[field] !== undefined, `${probe.probeId ?? '(无 id)'} 缺少 ${field}`)
    assert(typeof probe.probeId === 'string' && probe.probeId.length > 0, 'probeId 必须是非空字符串')
    assert(!ids.has(probe.probeId), `probeId 重复：${probe.probeId}`)
    ids.add(probe.probeId)
    assert(GROUPS.has(probe.group), `${probe.probeId} 的 group 不合法：${probe.group}`)
    assert(Number.isInteger(probe.maxTokens) && probe.maxTokens > 0 && probe.maxTokens <= 64, `${probe.probeId} 的 maxTokens 超出 1–64`)
    assert(Number.isInteger(probe.samples) && probe.samples > 0 && probe.samples <= 64, `${probe.probeId} 的 samples 超出 1–64`)
    assert(typeof probe.params === 'object' && probe.params !== null, `${probe.probeId} 的 params 必须是对象`)
    if (probe.group === 'C') {
      assert(typeof probe.promptFile === 'string', `${probe.probeId}（C 组）缺少 promptFile`)
      assert(typeof probe.promptSha256 === 'string' && /^sha256:[0-9a-f]{64}$/u.test(probe.promptSha256), `${probe.probeId}（C 组）缺少合法 promptSha256`)
      assert(probe.readFrom === 'second', `${probe.probeId}（C 组）readFrom 必须固定为 second`)
    } else {
      assert(typeof probe.prompt === 'string' && probe.prompt.length > 0, `${probe.probeId} 缺少 prompt`)
    }
  }
  return true
}

/**
 * 展开探针组：解析 C 组 promptFile，返回可直接发请求的探针（保留全部字段）。
 * @param {string} probesDir
 */
export async function loadProbeSet (probesDir) {
  const file = join(probesDir, 'probe-set.json')
  let probeSet
  try {
    probeSet = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`读取 ${file} 失败：${error.message}`)
  }
  validateProbeSet(probeSet)
  const expanded = []
  for (const probe of probeSet.probes) {
    if (probe.group !== 'C') {
      expanded.push({ ...probe, promptResolved: probe.prompt })
      continue
    }
    const promptFile = join(probesDir, probe.promptFile)
    const prefix = await readFile(promptFile, 'utf8')
    const actual = 'sha256:' + createHash('sha256').update(prefix, 'utf8').digest('hex')
    if (actual !== probe.promptSha256) {
      throw new Error(`C 组前缀被改过：${promptFile} 的 sha256=${actual}，探针组要求 ${probe.promptSha256}`)
    }
    expanded.push({ ...probe, promptResolved: `${prefix}${probe.promptSuffix ?? ''}`, prefixBytes: Buffer.byteLength(prefix, 'utf8') })
  }
  return {
    probeSet: { ...probeSet, probes: expanded },
    probeSetHash: computeProbeSetHash(probeSet),
  }
}

/** 按组筛选（冒烟/排障用；partial 批次不参与基线/判定）。 */
export function filterProbes (probes, groups) {
  if (groups === undefined || groups === null || groups.length === 0) return probes
  const wanted = new Set(groups)
  return probes.filter((probe) => wanted.has(probe.group))
}

/**
 * 粗估一次探针组的 token 开销（用于打印预算；不是计费承诺）。
 * 口径来自 docs/PREREQUISITES.md §4，T 组按本仓库实际的 5 条探针折算。
 */
export function estimateTokens (probes) {
  const perRequest = { T: 45, L: 47, G: 54, S: 36 }
  let total = 0
  for (const probe of probes) {
    if (probe.group === 'C') total += 2 * ((probe.prefixTokens ?? 2000) + 30)
    else total += probe.samples * (perRequest[probe.group] ?? 50)
  }
  return total
}

/** 探针组摘要，用于 status/日志。 */
export function summarizeProbeSet (probes) {
  const byGroup = {}
  for (const probe of probes) {
    byGroup[probe.group] = byGroup[probe.group] ?? { probes: 0, requests: 0 }
    byGroup[probe.group].probes += 1
    byGroup[probe.group].requests += probe.samples
  }
  return { probes: probes.length, requests: probes.reduce((sum, probe) => sum + probe.samples, 0), byGroup }
}
