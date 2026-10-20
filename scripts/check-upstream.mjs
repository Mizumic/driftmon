#!/usr/bin/env node
// driftmon · 上游参考实现更新检查（只读、不写文件、不改工件）
//
// 关注两个官方仓库：
//   deepseek-ai/deepseek-recipe —— T 通道「官方参照」的来源（包版本 / commit / tokenizer 内容）
//   deepseek-ai/DeepInfer       —— 解释层（运行时开关、平台数值差异、部署语义；不运行、不作依赖）
//
// 用法：
//   node scripts/check-upstream.mjs [--json]
//
// 退出码：0 = 无变化；1 = 有变化（需人工 review）；2 = 检查失败（网络 / GitHub API）。
// 判读与处理流程见 docs/TOKENIZER-REFERENCE.md §4–§5。

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REFERENCE_FILE = join(ROOT, 'data', 'reference', 'official-tokenizer-v41.json')
const GITHUB_API = 'https://api.github.com'
const TIMEOUT_MS = 15000

// DeepInfer 不是运行时依赖，只记录「上次人工阅读」的 commit（与 docs/TOKENIZER-REFERENCE.md §5 同步）。
const DEEPINFER_PIN = '8b16149741a4935e1dec8cea27853f273b374c5b'

async function github (path) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'driftmon-upstream-check' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub API ${path} → HTTP ${response.status}`)
  return response.json()
}

function short (sha) {
  return typeof sha === 'string' && sha.length >= 9 ? sha.slice(0, 9) : String(sha ?? '?')
}

function mark (changed) {
  return changed ? '⚠ 已变化' : '✓ 未变'
}

export async function checkUpstream () {
  const reference = JSON.parse(await readFile(REFERENCE_FILE, 'utf8'))
  const pinnedRecipe = reference.referenceImplementation?.sourceCommit ?? null
  const pinnedTokenizerBlob = reference.tokenizer?.gitBlobSha ?? null
  const [recipeCommit, tokenizerFile, deepinferCommit] = await Promise.all([
    github('/repos/deepseek-ai/deepseek-recipe/commits/main'),
    github('/repos/deepseek-ai/deepseek-recipe/contents/static/tokenizers/v41/tokenizer.json'),
    github('/repos/deepseek-ai/DeepInfer/commits/main'),
  ])
  const recipe = {
    pinnedCommit: pinnedRecipe,
    latestCommit: recipeCommit?.sha ?? null,
    commitChanged: pinnedRecipe !== (recipeCommit?.sha ?? null),
    pinnedTokenizerBlob,
    latestTokenizerBlob: tokenizerFile?.sha ?? null,
    tokenizerChanged: pinnedTokenizerBlob !== (tokenizerFile?.sha ?? null),
  }
  const deepinfer = {
    pinnedCommit: DEEPINFER_PIN,
    latestCommit: deepinferCommit?.sha ?? null,
    changed: DEEPINFER_PIN !== (deepinferCommit?.sha ?? null),
  }
  const changed = recipe.commitChanged || recipe.tokenizerChanged || deepinfer.changed
  return {
    checkedAt: new Date().toISOString(),
    reference: {
      package: reference.referenceImplementation?.package ?? null,
      version: reference.referenceImplementation?.version ?? null,
      tokenizerSha256: reference.tokenizer?.sha256 ?? null,
    },
    recipe,
    deepinfer,
    changed,
  }
}

function printHuman (result) {
  const recipe = result.recipe
  const deepinfer = result.deepinfer
  console.log(`上游参考实现更新检查（${result.checkedAt}）`)
  console.log(`deepseek-recipe main   ${short(recipe.latestCommit)} ${mark(recipe.commitChanged)}（工件基线 ${short(recipe.pinnedCommit)}）`)
  console.log(`  tokenizer blob       ${short(recipe.latestTokenizerBlob)} ${mark(recipe.tokenizerChanged)}（工件基线 ${short(recipe.pinnedTokenizerBlob)}）`)
  console.log(`  包版本（工件记录）   ${result.reference.version ?? '?'}（若 commit 变了，先看上游 CHANGELOG 再决定是否升级）`)
  console.log(`DeepInfer main         ${short(deepinfer.latestCommit)} ${mark(deepinfer.changed)}（观测基线 ${short(deepinfer.pinnedCommit)}）`)
  console.log('')
  if (!result.changed) {
    console.log('结论：未发现上游变化；T 参照工件无需重建。')
    return
  }
  console.log('结论：发现上游变化 →')
  if (recipe.commitChanged || recipe.tokenizerChanged) {
    console.log('  · deepseek-recipe / tokenizer 有变化：按 docs/TOKENIZER-REFERENCE.md §4 复核工件（--check），')
    console.log('    确认后再替换；换工件意味着历史 T 向量不再与官方参考可比。')
  }
  if (deepinfer.changed) {
    console.log('  · DeepInfer 有变化：读 docs/PREREQUISITES.md §7 的映射，判断是否影响归因逻辑（不需要重建 T 工件）。')
  }
}

async function main () {
  const json = process.argv.includes('--json')
  let result
  try {
    result = await checkUpstream()
  } catch (error) {
    console.error(`上游检查失败：${error instanceof Error ? error.message : String(error)}`)
    console.error('（网络/GitHub API 不可用不影响 driftmon 本身；稍后重试即可。）')
    return 2
  }
  if (json) console.log(JSON.stringify(result, null, 2))
  else printHuman(result)
  return result.changed ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
