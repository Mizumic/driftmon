// driftmon · 报告层（人可读）
//
// 只做一件事：把判定层的结果渲染成能被人读的报告。不下新结论、不改判定。

import { writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describeEndpoint } from './plugin-dep.mjs'

const VERDICT_EMOJI = {
  insufficient: '⚪',
  stable: '🟢',
  'route-change': '🔀',
  'drift-candidate': '🟡',
  'drift-confirmed': '🔴',
}

const CHANNEL_NAMES = {
  T: 'T · token 计数',
  L: 'L · logprob 分布',
  G: 'G · glitch 失败向量',
  C: 'C · prompt cache',
  S: 'S · TTFT',
}

function formatTime (timestamp) {
  if (typeof timestamp !== 'number') return '—'
  return new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, 'Z')
}

function channelRow (channel, verdict) {
  const evidence = verdict.channels?.[channel]
  if (evidence === undefined) return null
  if (evidence === null) return [CHANNEL_NAMES[channel], '—', '本批不可用', '—']
  if (channel === 'T') return [CHANNEL_NAMES[channel], `向量 ${JSON.stringify(evidence.vector)}`, '逐项与基线向量比较', evidence.hash.slice(0, 18) + '…']
  if (channel === 'L') {
    return [CHANNEL_NAMES[channel], `top-k 重合度中位数 ${fmt(evidence.topKJaccardMedian)}（${evidence.samples} 样本 / ${evidence.distinctTokenSequences} 种序列）`, '与基线 p50 比下降', `logprob 中位数 ${fmt(evidence.logprobMedian)}`]
  }
  if (channel === 'G') return [CHANNEL_NAMES[channel], `失败率 ${fmt(evidence.failRate)}（${evidence.fails.length}/${evidence.tokens}）`, '与基线失败率做二项检验', evidence.fails.length === 0 ? '无失败' : evidence.fails.slice(0, 4).join(', ')]
  if (channel === 'C') return [CHANNEL_NAMES[channel], `第二次命中率 ${fmt(evidence.hitRatio)}`, '与基线 p50 比下降', `prompt ${evidence.second?.promptTokens ?? '—'} / cached ${evidence.second?.cachedTokens ?? '—'}`]
  if (channel === 'S') return [CHANNEL_NAMES[channel], `TTFT 中位数 ${fmt(evidence.ttftMedian)}ms`, '与基线 p95 比上升', `样本 ${evidence.samples}`]
  return [channel, '—', '—', '—']
}

function fmt (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '') : '—'
}

/**
 * 渲染一份人可读报告。
 * @param {object} options
 * @param {object} options.verdict - judge() 的返回值
 * @param {object} [options.dependency] - 被动层依赖（用于标注端点是否已登记）
 * @param {object} [options.baseline]
 */
export function renderReport ({ verdict, dependency, baseline }) {
  const lines = []
  const name = `${verdict.provider}/${verdict.model}`
  lines.push(`# driftmon 报告 · ${name}`)
  lines.push('')
  lines.push(`- 判定：**${VERDICT_EMOJI[verdict.verdict] ?? ''} ${verdict.verdict}**（${verdict.reason}）`)
  lines.push(`- 说明：${verdict.detail ?? '—'}`)
  lines.push(`- 时间窗：${formatTime(verdict.window.from)} → ${formatTime(verdict.window.to)}（${verdict.window.batches} 批 / ${verdict.window.samples} 样本）`)
  lines.push(`- 基线：version ${verdict.baselineVersion ?? '—'} · probeSetHash \`${verdict.probeSetHash ?? '—'}\``)
  lines.push(`- 口径：一份观测仪表，不是鉴定报告；说不出「变成了什么模型」。`)
  lines.push('')

  if (verdict.endpointId !== null) {
    const dep = describeEndpoint(dependency, verdict.endpointId)
    const registered = dep.registered === true ? `已登记（插件累计 ${dep.counted} 次，最近 ${formatTime(dep.lastSeenAt)}）` : '未在插件登记表里'
    lines.push(`## 端点`)
    lines.push('')
    lines.push(`- 本次判定所属端点：\`${verdict.endpointId}\` · ${registered}`)
    lines.push('')
  }

  if (Array.isArray(verdict.endpoints) && verdict.endpoints.length > 0) {
    lines.push('## 窗口内端点分布（路由漂移）')
    lines.push('')
    lines.push('| 端点 | 批次数 | 插件登记 |')
    lines.push('| --- | --- | --- |')
    for (const row of verdict.endpoints) {
      const dep = describeEndpoint(dependency, row.endpointId)
      lines.push(`| \`${row.endpointId}\` | ${row.batches} | ${dep.registered === true ? '是' : '否'} |`)
    }
    lines.push('')
  }

  if (verdict.verdict !== 'insufficient' && verdict.channels !== null) {
    lines.push('## 通道证据（本批）')
    lines.push('')
    lines.push('| 通道 | 观测值 | 比较方式 | 备注 |')
    lines.push('| --- | --- | --- | --- |')
    for (const channel of ['T', 'L', 'G', 'C', 'S']) {
      const row = channelRow(channel, verdict)
      if (row !== null) lines.push(`| ${row.join(' | ')} |`)
    }
    lines.push('')
  }

  if (Array.isArray(verdict.signals) && verdict.signals.length > 0) {
    lines.push('## 超阈值信号')
    lines.push('')
    for (const signal of verdict.signals) lines.push(`- \`${signal.channel}\`（${signal.source}）：${signal.detail}${signal.strong === true ? '（强信号）' : ''}`)
    lines.push('')
  }

  lines.push('## 阈值（本轮判定实际使用的值）')
  lines.push('')
  for (const [key, value] of Object.entries(verdict.thresholds ?? {})) lines.push(`- \`${key}\` = ${JSON.stringify(value)}`)
  lines.push('')

  if (baseline !== undefined && baseline !== null) {
    lines.push('## 基线概览')
    lines.push('')
    lines.push('| 端点 | 批次数 | 样本数 | 可用通道 |')
    lines.push('| --- | --- | --- | --- |')
    for (const [endpointId, endpoint] of Object.entries(baseline.endpoints ?? {})) {
      const channels = Object.entries(endpoint.channels ?? {}).filter(([, value]) => value !== null).map(([key]) => key).join(',')
      lines.push(`| \`${endpointId}\` | ${endpoint.batches} | ${endpoint.samples} | ${channels || '—'} |`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push(`生成时间：${formatTime(Date.now())} · 判定器只消费原始层，可拿 data/raw 重算。`)
  lines.push('')
  return lines.join('\n')
}

/** 写报告文件；返回路径。 */
export async function writeReport (file, content) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  return file
}
