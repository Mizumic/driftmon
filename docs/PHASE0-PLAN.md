# Phase 0 · 噪声标定执行计划（runbook）

> **状态（2026-10-20）**：工具已就绪（`baseline noise-floor` + 采集脚本 + 本 runbook）；
> **30 轮采集尚未跑**（等用户授权/时间窗口）。验收标准见 [`ROADMAP.md`](ROADMAP.md) Phase 0。
>
> **原则**：同一端点、同一模型、同一天连跑 ≥30 轮；原始层 append-only；key 只走环境变量；
> 噪声底只是「自然波动范围」，阈值替换必须人工 review，不自动改 `config.json`。

## 0. 成本与时间（先看这个）

| 项 | 数值 | 来源 |
| --- | --- | --- |
| 一轮 = 8 新会话 × 22 条探针 | 288 个请求 | `collect --dry-run` |
| 单轮 token | 约 **37.7k** | `collect --dry-run` 的预算口径 |
| 30 轮 token | 约 **1.1–1.4M** | 37.7k × 30；ROADMAP 估算 ≈ 1.4M |
| 30 轮费用 | 约 **$0.36**（≈¥2.6） | `docs/ROADMAP.md` / `docs/PREREQUISITES.md §4` |
| 30 轮时长 | 约 **2 小时**（3.4 min/轮 + 60s 间隔） | 已有 5 轮实测 17.1 分钟 |

> 采集会真的花钱。先在 §1 跑 dry-run 确认，再决定是否执行 §3。

## 1. 前置检查（不花钱）

```bash
cd driftmon
node -v                                  # >= 20
npm test                                 # 全部离线测试通过
ls config.official-deepseek.example.json # 官方端点配置
echo "${DEEPSEEK_API_KEY:+set}"          # 只确认“已设置”，不要打印值
```

key 只从环境变量读（配置文件里只有 `apiKeyEnv` 变量名）。**不要把 key 写进任何文件/提交/日志。**

## 2. dry-run（不花钱，验证配置与第一个请求）

```bash
./scripts/phase0-calibrate.sh --dry-run
```

期望输出：一轮 8 会话 × 22 探针 = 288 请求；`POST https://api.deepseek.com/chat/completions`；
`max_tokens=1`。若配置/网络/key 有问题，这一步就会暴露。

## 3. 正式采集 30 轮（会花钱）

```bash
# 前台（~2h，中途 Ctrl-C 可停；重跑同一命令即续跑）
./scripts/phase0-calibrate.sh --rounds 30 --interval 60

# 或后台（推荐，断开终端也不影响）
nohup ./scripts/phase0-calibrate.sh --rounds 30 --interval 60 \
  > .local/phase0/nohup.log 2>&1 &
```

* 状态文件：`.local/phase0/rounds.done`（已完成轮次；重跑自动续，不会重采）。
* 日志：`.local/phase0/calibrate-*.log`（gitignored，不进仓库）。
* 每轮 `collect` 追加写 `data/raw/YYYY-MM-DD.jsonl`，**失败不会破坏已落盘数据**。
* 全部请求失败（key/端点问题）才退出；单请求失败只记在批次错误里。

## 4. 派生 + 阈值 review（采集完成后）

```bash
CFG=config.official-deepseek.example.json
node bin/driftmon.mjs baseline build       --config "$CFG"
node bin/driftmon.mjs baseline noise-floor --config "$CFG" --rounds 30
node bin/driftmon.mjs template check       --config "$CFG"
node bin/driftmon.mjs judge run            --config "$CFG"
```

检查 `data/baselines/noise-floor.json`（schema 见 [`DATA-MODEL.md`](DATA-MODEL.md) 层③）：

* `summary.verdict === "calibrated"`；`window.rounds >= 30`；
* 每个端点 `channels.T.distinctVectors === 1`（否则探针组没冻结/有隐藏变量）；
* 逐通道看 `usable` 与 `unusableChannels[].reason`：**允许结论是「这条通道不能用」**。

阈值替换（人工 review 后写进 `config.json`，不要自动改）：

| 配置项 | 依据 |
| --- | --- |
| `judge.thresholds.lMaxTopKJaccardDrop` | L 的 `topKJaccard.p05/p50` 与批间散布 |
| `judge.thresholds.sTtftRatio` | S 的 `p95/p50` 与端点间差异 |
| `judge.thresholds.gZScore` | G 的 `failRate + ci95` |
| `judge.thresholds.cHitRatioDrop` | C 的 `hitRatio.p05` |
| `gray.thresholds.*` | 同上（模板对比用同一份噪声底） |

阈值取「噪声底 + 安全余量」，并在 CHANGELOG/PR 里写清依据数值。改完后重跑
`template check` / `judge run`：无漂移时结果应是 `stable`/`insufficient`，而不是 `drift-*`。

## 5. 固化证据与文档（验收）

* [`EVIDENCE.md`](EVIDENCE.md) 增加 **E10**：30 轮窗口、噪声底摘要、模板对比结论；
* [`ROADMAP.md`](ROADMAP.md) Phase 0 验收项逐条勾选（T 唯一 / L p50+p95 / G p50+CI / S p50+p95 /
  不可用通道说明 / 每轮落盘 / 脚本是文件可重跑）；
* `CHANGELOG.md` 记录标定结果与阈值变更；
* 提交并推送 GitHub（主仓）。

## 6. 定期化（可选，需用户同意）

```cron
# 每天一轮巡检 + 模板对比（示例：时间/路径按本机展开，不要提交真实路径）
10 9 * * * cd <driftmon> && set -a && . .local/symbols.env && set +a && node bin/driftmon.mjs collect --sessions 8 && node bin/driftmon.mjs template check
```

建议先手动跑 1–2 周，确认噪声稳定后再挂 cron/systemd。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| key 失效 / 限流 | 脚本失败即停；修复后重跑同一命令续采（append-only） |
| 网络抖动 | `collect` 内建 retries；只有「全部请求失败」才抛错 |
| 跨天数据 | Phase 0 要求同一天 30 轮；跨天批次可作对照，但不能凑数 |
| 成本超预期 | dry-run 先看单轮预算；`--rounds` 可改小先跑 5 轮观察 |
| 端点/模型切换 | 噪声底只对当前 `provider/model` 有效；换端点必须重跑 |
| 噪声底被误用 | `summary.verdict` 不是 `calibrated` 时不要用来调阈值 |

## 8. 与 ROADMAP 验收项的对应

| ROADMAP Phase 0 验收项 | 本次计划里的产出/检查 |
| --- | --- |
| 「按端点分组的 T 通道向量始终完全相同」 | `noise-floor.json` → `endpoints.<id>.channels.T.distinctVectors === 1` |
| 「L 给出 p50 / p95」 | `channels.L.topKJaccard.{p50,p95,p99}` + `logprobMedian`/`logprobIqr` |
| 「G 给出 p50 与 95% CI」 | `channels.G.{failRate, ci95, failRateDistribution}` |
| 「S 给出 p50 / p95」 | `channels.S.ttftMs.{p50,p95,p99}` |
| 「明确哪些通道不可用」 | `unusableChannels` / `unavailableChannels` + `summary.judgementUsable` |
| 「每轮原始输出落盘」 | `scripts/phase0-calibrate.sh` 每轮 `collect` 追加 `data/raw/` |
| 「采集脚本是文件、能重跑」 | `scripts/phase0-calibrate.sh`（可 dry-run、可续跑、状态/日志在 `.local/`） |
