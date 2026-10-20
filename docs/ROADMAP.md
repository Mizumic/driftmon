# 路线图与验收标准

> 原则：**先把噪声底量出来，再谈判定。**任何跳过 Phase 0 的实现都会把噪声当漂移。

## 实现状态（2026-10-20）

Phase 0/1 的**代码骨架已就绪**：`collect`（K 新会话 × 冻结探针组）、`signature`（五通道纯函数）、
`baseline`（按端点分组 + 噪声底）、`judge`（五值状态机，可回放）、`report`，**71 项离线测试全过**
（含 `template` 已知检查点模板、`gray` 行为告警、官方直连端点归一化、插件 `config.json` 只读消费）。
真实网关单会话冒烟已跑通（T/L/G/C/S 五组都有数据，批次标 `partial: true`）；
官方端点已用 5 轮完整巡检固化 `flash 1017` 行为模板（40 批 / 1440 样本 / 0 错误，见
`data/templates/` 与 `docs/EVIDENCE.md` E9）。

**Phase 0 的 30 轮标定已于 2026-10-20 完成**（官方端点同一天 30 轮 / 240 批 / 8640 请求 / 0 错误，
`noise-floor.json` 的 `verdict=calibrated`，五通道全部可用，见 `docs/EVIDENCE.md` E10）。
判定阈值已按噪声底校准（`lMaxTopKJaccardDrop 0.05→0.10`、`sTtftRatio 1.5→2.5`；G/C 与
`gray.*` 复核后保留），`template check` / `judge run` 复跑均为 `stable`。
**但阈值只在官方 flash 1017 这一端点/模型上标定过**：换端点、换模型或换探针组必须重跑 Phase 0；
`drift-confirmed` 在跨端点回放验收（Phase 2）之前仍只用于结构验证。

---

## Phase 0 · 噪声标定（前置，最重要）

**做什么**

1. 冻结探针组定义（`probes/probe-set.json`），算出 `probeSetHash`；
2. 在同一天、同一端点、同一模型上跑 **≥30 轮**完整探针组；
3. 对每个通道算自然波动分布（中位数、p95、p99、唯一值计数）；
4. 写出 `data/baselines/noise-floor.json`。

**验收标准**

* [x] **按端点分组后**，同一端点的 `T` 通道向量**始终完全相同**（不同则说明探针组没冻结或存在隐藏变量）；
      跨端点不同是**预期的**（实测 `manhattan=36` vs `orcarouter=64`），必须归入路由差异而不是噪声；
      （2026-10-20：`direct:deepseek-official` 240/240 批恒为 `[18,17,17,39,16]`）
* [x] `L` 通道给出 top-k Jaccard 重合度的 p50 / p95（2026-10-20：p50=0.852、p05=0.786、p95=1.000）；
* [x] `G` 通道给出失败率的 p50 与 95% 置信区间（2026-10-20：失败 720/3360=21.4%，CI [0.201,0.228]）；
* [x] `S` 通道给出 TTFT 的 p50 / p95（2026-10-20：128 / 235ms）；
* [x] 明确写出**哪些通道噪声太大、不足以支撑判定**（本次结论：五通道全部可用；L 的 logprob 子信号退化
      IQR=0，实际只用 top-k 集合；L top-k 存在小时级非平稳性，已计入阈值）；
* [x] **每一轮的原始输出都已落盘**到 `data/raw/`（`data/raw/2026-10-20.jsonl`，240 批，不允许只 print）
      ——这是本次的教训，见 `docs/EVIDENCE.md`；
* [x] 采集脚本本身是**文件**（不是一次性内联命令），且能一键重跑出同一格式
      （`scripts/phase0-calibrate.sh`，可 dry-run/断点续跑）。

**产出**：`data/raw/*.jsonl` + `data/baselines/noise-floor.json`

**执行工具（2026-10-20 完成采集；工具可重跑）**：

* 采集：`scripts/phase0-calibrate.sh`（30 轮、可 dry-run、可断点续跑，状态/日志写 `.local/phase0/`）；
* 派生：`driftmon baseline noise-floor [--rounds 30]` → 按端点/通道的自然波动分布 + 可用性判定；
* 阈值 review：`scripts/phase0-threshold-review.mjs`（只读滚动回放，人工定阈值）；
* runbook：`docs/PHASE0-PLAN.md`（成本/时间、步骤、阈值 review、验收映射）。

**"轮"的定义（全局统一，别处都按这个）**：**一轮巡检 = K≥8 个新会话，每个会话发一次完整探针组**。
Phase 0 的"30 轮"= 30 轮巡检 = 240 次探针组；**实测** 892k token / 8640 请求 / 2h07m
（估算 1.4M token ≈ $0.36，实际更低；详见 `PREREQUISITES.md §4` 与 `docs/EVIDENCE.md` E10）。

---

## 已知检查点模板（2026-10-20，Phase 1 旁支）

**做什么**：以官方端点 `system_fingerprint` 为 ground truth，把「已知检查点」在冻结探针组下的
行为签名固化成模板（`data/templates/checkpoint-*.json`），给两类用途做参考物：

* 官方**灰度检测**：指纹没变、但 `behaviorChannels`（L top-k / G）相对模板偏移或双峰；
* 无指纹网关**反推检查点**：行为签名对模板挑最接近的检查点。

**验收标准**

* [x] 官方端点跑满 **5 轮完整巡检**（每轮 K=8），产出 `data/raw/2026-10-19.jsonl`（append-only，50 批）；
* [x] flash 1017 模板固化：40 批 / 1440 样本 / 0 错误；T 向量 40 批唯一 `[18,17,17,39,16]`；
      G 失败集合 40 批一致（3/14）；L top-k 中位 0.819；C 命中 0.889；S 中位 117ms；
* [x] `template build` / `template check` 都是可重跑 CLI（纯函数聚合 + 不联网），并有离线测试；
* [x] 行为告警：`template check` → `results/watch/gray-watch.json`（通用 v1；当前 `stable`），
      可被展示层（插件 `externalAlertFile`）合并进指纹徽标；
* [ ] 把模板接进判定/告警（指纹不变 + 行为通道偏移/双峰 → `gray-candidate`）——需要先在 Phase 3
      时间序列上标定「正常波动 vs 灰度」；
* [ ] 用无指纹网关（`opencode-go` 各端点）样本验证「行为对模板反推检查点」的区分度。

**产出**：`data/templates/checkpoint-flash_1017.json`、`src/template.mjs`、`test/template.test.mjs`。

---

## T 通道官方参照（2026-10-20，Phase 1 旁支）

**做什么**：用官方开源的 [`deepseek-recipe`](https://github.com/deepseek-ai/deepseek-recipe)
（官方称其处理逻辑与 DeepSeek 官方 API 完整对齐）+ 自带 v41 tokenizer，**离线**算出冻结探针组的
期望 `prompt_tokens`，作为 T 通道的绝对参照；接入 `reference check`，让「token 计数对不对」
不再只依赖自比基线（自比基线发现不了「一开始就连着被换过的链路」）。

**验收标准**

* [x] 参考实现版本与内容哈希固定：`deepseek-recipe` 0.2.0、源码 commit `935817c…`、v41 tokenizer
      SHA-256 `81f64d12…`；工件 `data/reference/official-tokenizer-v41.json` 入库（含 `probeSetHash`）；
* [x] 5 条 T 探针期望向量 `[18,17,17,39,16]` 与 E9/E10 的 240/240 实测**逐项一致**（E11）→
      `flash 1017` 模板的 T 向量有官方实现背书；
* [x] `reference check` 可重跑、不联网、不花 token；`status` / `template check` 输出参照状态
      （不改 `gray-watch.json` schema，不影响展示契约）；
* [x] 离线测试把「工件 T 向量 = 模板 T 向量」固化成回归断言（测试 71 → 77 项）；
* [ ] 上游刷新流程实战演练一次（上游换 tokenizer / prompt 模板时，按
      `docs/TOKENIZER-REFERENCE.md` §4 review `.candidate.json` 再替换）；
* [ ] `judge` / `gray` 判定链在 T 变化时附带「官方参照是否一致」的归因提示（当前只在
      `template check` 的 stdout 里显示，未写进告警文件）。

**产出**：`data/reference/official-tokenizer-v41.json`、`src/tokenizer-reference.mjs`、
`scripts/build-tokenizer-reference.py`、`test/tokenizer-reference.test.mjs`、
`docs/TOKENIZER-REFERENCE.md`。

---

## Phase 1 · 单通道可用性验证

**做什么**：把三个原型探针收进 `src/`，逐通道验证"能不能真的区分两个不同的后端"
——用现成的对照组：`orcarouter-dsv4.1flash` vs `manhattan-project` vs `luminal-dsv4.1flash`。
注意三者的身份置信度不同：`orcarouter` = 高（公开路由器）、`luminal` = 中（疑似自托管）、
`manhattan` = 低（未确认），所以"它们是不同承载方式"是**推断**，本 Phase 的结论要独立于这个推断成立。

**验收标准**

* [ ] `T` 通道：能稳定把 `manhattan-project`（36）与 `orcarouter`（64）分开；
* [ ] `G` 通道：给出**跨端点的失败率差异是否显著**（本窗口的初步结论是"不显著"——允许此结论只是确认）；
* [ ] `L` 通道：给出跨端点的分布距离，并说明在 10 样本下是否可分；
* [ ] 每个通道输出一行结论：`可用 / 需更多样本 / 不可用`，附证据。

**产出**：`src/` + `results/reports/channel-*.md`

---

## Phase 2 · 判定器与路由归因

**做什么**：实现 §5 的状态机（`insufficient` / `stable` / `route-change` / `drift-candidate` /
`drift-confirmed`），并把"端点切换"从"模型漂移"里拆出来。

**验收标准**

* [ ] 用 Phase 1 的跨端点样本回放：**必须判成 `route-change`，而不是 `drift-candidate`**；
* [ ] 用同一端点的重复样本回放：**必须判成 `stable`**；
* [ ] 样本量不足时**必须**输出 `insufficient`，不得给结论；
* [ ] 每条判定都能回溯到 `baselineVersion` + `probeSetHash` + 时间窗。

**产出**：`src/judge*` + `results/alerts/*.json`

---

## Phase 3 · 时间序列与变点

**做什么**：连续跑 1–2 周（每 6 小时），把签名画成时间线，标出变点与端点切换点。

**验收标准**

* [ ] 端点轮转被记录成时间线事件（本窗口只观测到"按会话绑定"，周期未知）；
* [ ] 至少给出一次"端点在窗口内稳定、签名也稳定"的基线区间（证明系统在稳定态不误报）；
* [ ] 报告里明确区分**变点**与**端点切换**两类事件。

**产出**：`results/reports/timeline-*.md`

---

## Phase 4 ·（可选）跨供应商

**做什么**：把同一套探针组搬到其它供应商端点（官方 DeepSeek / OpenRouter / 直连厂商），
验证通道可用性表（`PREREQUISITES.md §1`）的普适性。

**验收标准**

* [ ] 给出至少 3 家的"通道可用性矩阵"；
* [ ] 明确记录哪些通道在哪些协议下不可用（例如官方端点没有 `logprobs`、网关没有 `system_fingerprint`）。

---

## 现在不做（明确推迟）

| 事项 | 原因 |
| --- | --- |
| "识别出具体版本号" | 原则上不可答，见 `DESIGN.md §1` 反问题 |
| 内容质量评测 / 回归测试 | 属另一件事，需要另一套基准 |
| 自动处置（自动切换 provider） | 先有可信判定再说；误判的自动切换比不切换更危险 |
