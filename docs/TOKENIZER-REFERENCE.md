# T 通道官方参照（tokenizer reference）

> **一句话**：T 通道原来只能「跟自己的历史比」；现在多了一个**官方参考实现离线算出的期望值**，
> 可以回答「我看到的 token 计数，是不是官方 tokenizer + prompt 模板应该给出的那个数」。
> 这是 T 通道的**身份/配置核验**，不是权重漂移判定。

---

## 1. 为什么需要它

T 通道（`usage.prompt_tokens` 向量）是唯一「单次测量、无采样噪声」的硬通道，但它原来的判据是
**自比基线**：第一次采集到的向量被当成基准，之后跟它比。这有一个结构性盲区——

* 如果第一次采集时链路**已经**被换过（不同 tokenizer、被注入 system prompt、模板不同），
  那么基线本身就是错的，之后永远不会报警；
* 反过来，换了 tokenizer 但行为统计变化很小时，也说不清是哪一层变了。

2026-10-20，DeepSeek 官方开源了生产级 Token 编解码组件
[`deepseek-recipe`](https://github.com/deepseek-ai/deepseek-recipe)（MIT）。官方部署 Q&A
（[DeepInfer/doc/DeepSeek V4.1 Flash 推理部署 Q&A.pdf](https://github.com/deepseek-ai/DeepInfer/blob/main/doc/DeepSeek%20V4.1%20Flash%20%E6%8E%A8%E7%90%86%E9%83%A8%E7%BD%B2%20Q%26A.pdf)）
明确写到：它负责「API 协议 ↔ 模型 token 序列」的转换，**处理逻辑与 DeepSeek 官方 API 完整对齐**。
它自带 V4.1 的 tokenizer、prompt 渲染规则（special token 分段、thinking / reasoning effort 模板、
工具调用格式），并且有 Python / Rust 绑定。

因此我们可以**离线**（不需要 GPU、不调用模型、不花 token）算出：在冻结探针组和我们的请求形状下，
官方实现认为每条 T 探针的 `prompt_tokens` 应该是多少。把它固化成工件入库，T 通道就有了绝对参照。

**实测结论（2026-10-20，E11）**：5 条 T 探针**全部精确对上**——

| 探针 | 官方参考实现期望 | 官方端点实测（E9/E10，240/240 批） |
| --- | ---: | ---: |
| `t-ascii` | 18 | 18 |
| `t-cjk` | 17 | 17 |
| `t-rare` | 17 | 17 |
| `t-special` | 39 | 39 |
| `t-unicode` | 16 | 16 |
| **向量** | **[18,17,17,39,16]** | **[18,17,17,39,16]** |

即：**`flash 1017` 模板里的 T 向量有官方实现背书**，不是只有「我们自己观测到它稳定」。

`t-special` 还有一个额外信息：这条探针的 prompt 里直接写了三个 special token 字面
（`<｜begin▁of▁thinking｜>` 等）。官方实现算出 `prompt_tokens=39`，而按**完整词表**编码只有 **29**——
因为官方语义是「用户文本里的 special token 字面按普通文本编码」，防止通过文本注入控制 token
影响模型行为（见 `deepseek-recipe` 的 `SpecialToken` / `PromptTokenizer` 实现与官方 Q&A）。
这个探针测的正是这条语义；如果哪天它从 39 变成 29，说明 special-token 处理方式变了（配置/版本变化），
而不是模型权重漂移。

---

## 2. 工件与代码

### 工件（入库，只读）

`data/reference/official-tokenizer-v41.json`，由 [`scripts/build-tokenizer-reference.py`](../scripts/build-tokenizer-reference.py)
生成。关键字段：

| 字段 | 内容 |
| --- | --- |
| `referenceImplementation` | `deepseek-recipe` 版本（**0.2.0**）、源码 commit（`935817c…`）、模型版本 `DeepSeek-V4.1-Flash`、编码器 `DeepseekV41Encoding`、模型别名（含 `deepseek-flash`） |
| `tokenizer` | `static/tokenizers/v41/tokenizer.json` 的 **SHA-256**（`81f64d12…`）、git blob sha（`3abdf13e…`）、大小、License（MIT）、上游模型与比对 revision |
| `probeSet` | 生成时的冻结探针组 `version` + `hash`（换探针组必须重建工件） |
| `requestTemplate` | 与 `src/collect.mjs` 的 `buildRequest()` 完全一致的请求形状（model / messages / max_tokens / params） |
| `probes` | 每条 T 探针的 `promptTokens` 与 `fullVocabularyTokens` |
| `vector` | 期望 T 向量（与 `probes[].promptTokens` 一致） |

工件里**没有本机绝对路径**；tokenizer 内容由 SHA-256 锁定，不依赖网络可重算。

### 代码

* [`src/tokenizer-reference.mjs`](../src/tokenizer-reference.mjs)：纯函数——工件自检、窗口过滤、
  实测 T 向量重算、与期望向量比对（`match` / `mismatch` / `insufficient`）。
* [`src/cli.mjs`](../src/cli.mjs)：新增 `driftmon reference check`；`status` 显示工件摘要与最近核对结果；
  `template check` 在输出里追加一行官方 T 参照状态（没有工件时静默跳过）。
* 测试：[`test/tokenizer-reference.test.mjs`](../test/tokenizer-reference.test.mjs)——把「官方背书」
  固化成回归断言（工件与模板 T 向量必须逐项一致、mismatch 逐探针 diff、CLI 端到端）。

```bash
node bin/driftmon.mjs reference check --config config.official-deepseek.example.json
# 🟢 tokenizer-reference match · deepseek-official/deepseek-flash
#   T 向量与官方参考一致（8 批）：tokenizer / prompt 模板与官方参考实现一致
#   deepseek-recipe 0.2.0 · tokenizer 81f64d1248a6…
#   probeSet=sha256:18c0a4ed381cc177d… · 期望 T 向量=[18,17,17,39,16]
# 已写入 results/reference/tokenizer-check.json（gitignored，可重建）
```

---

## 3. 如何判读结果

| `status` | 含义 | 下一步 |
| --- | --- | --- |
| `match` | T 向量与官方参考一致：tokenizer / prompt 模板 / 请求渲染路径与官方参考实现一致 | 无需动作；**不代表权重没变**（看 `judge` / `template check`） |
| `mismatch` | 某一层变了 | 按下面顺序排查，**不要**直接当模型漂移 |
| `insufficient` | 窗口内没有可比的完整批次（探针组/provider/model 不一致、partial、原始层空） | 攒一轮完整巡检再跑；这是合法结果 |

`mismatch` 的排查顺序（从最可能到最不可能）：

1. **tokenizer 换版**：`probes[].fullVocabularyTokens` 与 `promptTokens` 的相对关系变化、
   `t-special` 明显跳变（39↔29 类）→ 对齐 `deepseek-recipe` changelog / tokenizer 工件；
2. **prompt 模板变化**：所有探针一起 +N / −N（如 system message 插入、thinking 标记变化）；
   对照 `deepseek-recipe-encoding` 的渲染规则；
3. **请求渲染路径变化**：网关改写了请求（注入 system prompt、加 tool 定义、重排消息）——
   这类差异通常稳定且可解释，属于「配置/中间层变化」，应记 `config-change` 而不是权重漂移；
4. **探针组变化**：`probeSet.hash` 不一致会被 `reference check` 直接拒绝（需要先重建工件）。

> **对非官方端点的预期差异**：工件对标的官方实现（V4.1 tokenizer + 官方 prompt 模板）。网关/中转
> 可能用自己的 tokenizer、模板或请求改写（E2 已实测：special token 字面在两个网关分别计 36 / 64）。
> 因此**对网关跑出 `mismatch` 往往是预期结果**——它说明「该端点不与官方参考实现一致」，
> 可以作为「是否是官方实现」的判别信号，但**不应**直接当成漂移或故障。

> 语义边界：`match` 只覆盖 T 通道。供应商「只换权重、不动 tokenizer/模板」时 T 仍然是 match，
> 这种漂移只能靠 L/G 通道（见 `docs/DESIGN.md` §5–6）。

---

## 4. 重建 / 刷新工件（开发者流程）

依赖只在开发机装，**不进 driftmon 运行时**（driftmon 仍是纯 Node、零运行时依赖）：

```bash
# 1) 官方参考实现（与工件记录版本一致；网络受限时用镜像）
python3 -m pip install --target .local/ref-py deepseek-recipe==0.2.0
#   本机 PyPI 直连不通时：--index-url https://mirrors.aliyun.com/pypi/simple/

# 2) 官方 v41 tokenizer（内容由 SHA-256 锁定；commit 与工件记录一致）
curl -L -o .local/tokenizer-v41.json \
  https://raw.githubusercontent.com/deepseek-ai/deepseek-recipe/935817c66f5d6e64838f419692545f06787e485f/static/tokenizers/v41/tokenizer.json
sha256sum .local/tokenizer-v41.json   # 期望 81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99

# 3) 复核 / 重建（--check 只比对不写；重建时若向量或 tokenizer 变了会写 .candidate.json 并退出 2）
PYTHONPATH=.local/ref-py python3 scripts/build-tokenizer-reference.py \
  --tokenizer .local/tokenizer-v41.json --check
PYTHONPATH=.local/ref-py python3 scripts/build-tokenizer-reference.py \
  --tokenizer .local/tokenizer-v41.json
```

**刷新纪律**（重要）：

* 工件入库的是**评审过的冻结值**，任何工具都不会在运行时自动改它；
* 上游变更导致 `vector` / `tokenizer.sha256` / `referenceImplementation.version` 变化时，脚本默认
  **拒绝覆盖**，写 `official-tokenizer-v41.candidate.json` 并退出 2——人工 review 后再替换；
* 换工件 = 换参照：历史 T 向量不再与官方参考可比，必须同步更新 `docs/EVIDENCE.md` 的 E11、
  在 CHANGELOG 记录原因，并考虑是否需要重跑 Phase 0 / 重建模板；
* 探针组换版（`probeSetHash` 变化）必须重建工件；否则 `reference check` 会直接报错。

---

## 5. 上游更新关注

参考实现来自两个官方仓库，更新会影响「官方背书」的有效性。**它们目前没有 GitHub Releases/Tags**
（`releases/latest` 404、`tags` 为空），所以看 **commit / 文件内容**，不看 release。

本仓库记录的观测基线（**2026-10-20 检查**）：

| 仓库 | 观测基线 | 关注点 |
| --- | --- | --- |
| [`deepseek-ai/deepseek-recipe`](https://github.com/deepseek-ai/deepseek-recipe) | main `935817c66f5d6e64838f419692545f06787e485f`；包版本 0.2.0（2026-10-20 发布）；`static/tokenizers/v41/tokenizer.json` blob `3abdf13e3488acc65e11e6a57f073f6673175c3a` / SHA-256 `81f64d12…` | prompt 渲染、special token、tokenizer、`resolve_max_tokens` / `top_p` 归一化等语义 |
| [`deepseek-ai/DeepInfer`](https://github.com/deepseek-ai/DeepInfer) | main `8b16149741a4935e1dec8cea27853f273b374c5b`（2026-10-20） | 运行时开关（batch-invariant / MTP / YoCo 截断 / token blacklist）、平台数值差异、部署语义（见 `docs/PREREQUISITES.md` §7） |

一次性检查（只读，不写文件）：

```bash
node scripts/check-upstream.mjs          # 人可读摘要；有变化退出 1，网络失败退出 2
node scripts/check-upstream.mjs --json   # 机器可读
```

建议节奏：**每次准备新一轮采集/标定之前跑一次**；若 `check-upstream` 报 `deepseek-recipe` 或
tokenizer 有变化，先按 §4 复核工件，再决定是否更新参照。DeepInfer 的变化通常只是「解释层」更新，
按 `docs/PREREQUISITES.md` §7 的映射判断是否影响归因逻辑即可。

> 关联：官方参考实现还给出了平台差异的证据（同 checkpoint 在 NVIDIA 与 Ascend 的 golden PPL
> 数值不同）与一批「不改权重就能改变行为」的开关清单；这些**思路引用**整理在
> [`docs/PREREQUISITES.md`](PREREQUISITES.md) §7，**不运行 DeepInfer**，也不把它的代码引入依赖。
