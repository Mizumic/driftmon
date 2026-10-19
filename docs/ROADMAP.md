# 路线图与验收标准

> 原则：**先把噪声底量出来，再谈判定。**任何跳过 Phase 0 的实现都会把噪声当漂移。

## 实现状态（2026-10-20）

Phase 0/1 的**代码骨架已就绪**：`collect`（K 新会话 × 冻结探针组）、`signature`（五通道纯函数）、
`baseline`（按端点分组 + 噪声底）、`judge`（五值状态机，可回放）、`report`，**64 项离线测试全过**
（含 `template` 已知检查点模板、`gray` 行为告警、官方直连端点归一化、插件 `config.json` 只读消费）。
真实网关单会话冒烟已跑通（T/L/G/C/S 五组都有数据，批次标 `partial: true`）；
官方端点已用 5 轮完整巡检固化 `flash 1017` 行为模板（40 批 / 1440 样本 / 0 错误，见
`data/templates/` 与 `docs/EVIDENCE.md` E9）。

**但仍然没有跑 Phase 0 的 30 轮标定**——下面各 Phase 的验收项一个都没勾（那需要连续真实采集）。
在标定完成之前：判定阈值是默认值、`drift-confirmed` 只用于结构验证，不能当作对外结论。

---

## Phase 0 · 噪声标定（前置，最重要）

**做什么**

1. 冻结探针组定义（`probes/probe-set.json`），算出 `probeSetHash`；
2. 在同一天、同一端点、同一模型上跑 **≥30 轮**完整探针组；
3. 对每个通道算自然波动分布（中位数、p95、p99、唯一值计数）；
4. 写出 `data/baselines/noise-floor.json`。

**验收标准**

* [ ] **按端点分组后**，同一端点的 `T` 通道向量**始终完全相同**（不同则说明探针组没冻结或存在隐藏变量）；
      跨端点不同是**预期的**（实测 `manhattan=36` vs `orcarouter=64`），必须归入路由差异而不是噪声；
* [ ] `L` 通道给出 top-k Jaccard 重合度的 p50 / p95；
* [ ] `G` 通道给出失败率的 p50 与 95% 置信区间；
* [ ] `S` 通道给出 TTFT 的 p50 / p95；
* [ ] 明确写出**哪些通道噪声太大、不足以支撑判定**（允许结论是"这条通道不能用"）；
* [ ] **每一轮的原始输出都已落盘**到 `data/raw/`（不允许只 print）——这是本次的教训，见 `docs/EVIDENCE.md`；
* [ ] 采集脚本本身是**文件**（不是一次性内联命令），且能一键重跑出同一格式。

**产出**：`data/raw/*.jsonl` + `data/baselines/noise-floor.json`

**"轮"的定义（全局统一，别处都按这个）**：**一轮巡检 = K≥8 个新会话，每个会话发一次完整探针组**。
Phase 0 的"30 轮"= 30 轮巡检 = 240 次探针组 ≈ 1.4M token ≈ **$0.36**（详见 `PREREQUISITES.md §4`）。

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
