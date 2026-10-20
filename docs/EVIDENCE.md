# 证据索引

> **这份索引解决一个问题**：driftmon 正文里的每个实测数字，**到底是哪台机器、哪个脚本、什么时候产出的**。
>
> 建立它的直接原因：本项目的三条核心证据（token 计数差分、logprob 签名、glitch 失败向量）
> 的**原始输出从未落盘**，只存在于会话日志里——文档里那几个数字是**手抄**的。
> 这违反了本项目自己的第一条原则（原始观测不可再生），必须如实记录并修掉。

## 约定：证据的三种状态

| 状态 | 含义 | 可信度 |
| --- | --- | --- |
| **机器产物** | 脚本直接写出的文件，路径可查、可重算 | 最高 |
| **转录** | 从会话日志抄进 `data/raw/` 的文本，标注了来源与截断处 | 中（需重跑复核） |
| **文档转述** | 只写在 `docs/*.md` 正文里的数字，没有对应原始输出 | 最低（**应逐步消除**） |

## 索引表

| 证据 | 支撑的结论 | 脚本 | 原始输出 | 状态 |
| --- | --- | --- | --- | --- |
| E1a 对照探测 | 官方端点同形态流式：raw 里带 `e72d3c7f…`；网关侧 raw 里无此字段 | `.scratch/opencode-fp/probe.py` | `.scratch/opencode-fp/report-v2.json`（网关 5 chunk / 官方 10 chunk） | **机器产物** |
| E1b 六模型扫描 | 6 个模型全部无 `system_fingerprint`；"18 chunk" 出自**另一次流式复刻**（网关与官方各 18 chunk） | 一次性内联脚本 | 会话日志（未落盘） | **可从日志恢复** |
| E2 token 计数差分 | 普通文本**在两端点一致**；特殊 token 字面 `manhattan=36` vs `orcarouter=64`（当时尚未发现 luminal） | `.scratch/fp-gateway/tokenizer-race.py` | `data/raw/2026-10-17-transcripts/tokenizer-race.txt` | **转录**（原脚本无落盘） |
| E3 logprob 不可复现 | `temperature: 0` 下序列与数值都变；89 轮全落同一端点 | `.scratch/fp-gateway/logprob-race.py` | `data/raw/2026-10-17-transcripts/logprob-race.txt` | **转录** |
| E4 glitch 失败向量 | 两端点都 ≈11–12/14 失败、集合逐轮变化 | `.scratch/fp-gateway/glitch-battery.py` | `data/raw/2026-10-17-transcripts/glitch-battery.txt` | **转录** |
| E5 端点命名体系 | 37 个模型 → endpoint id → 上游串，分类出 vendor/router/协议后缀… | 一次性内联脚本 | `data/raw/2026-10-17-transcripts/endpoint-survey.txt` | **转录** |
| E6 路由按会话绑定 | A/B 两会话 20 对里 18 一致、2 对不同 | 一次性内联脚本 | 可从会话日志恢复（见下「会话日志的读法」） | **可从日志恢复**（未落盘） |
| E7 端点登记表 | 20 个端点、1 个未确认 | `opencode-go/collect-endpoints.mjs` | `opencode-go/endpoint-registry.json` | **机器产物** |
| E8 原始响应字节 | 网关响应无指纹、响应头可回溯 | `plugins/dsh-system-fingerprint`（运行中） | `home/storages/system-fingerprint/raw/*.sse` | **机器产物**（滚动 120 份） |
| E9 官方检查点模板 | 官方 flash 检查点 = `e72d3c7f…`；**5 轮 / 40 批 / 1440 样本**：T 向量恒 `[18,17,17,39,16]`（40/40）、G 失败 3/14 且集合 40/40 一致、L top-k 中位 0.819、C 命中 0.889、TTFT 中位 117ms（105–179） | `bin/driftmon.mjs collect` / `template build` / `template check`（`src/collect.mjs`、`src/template.mjs`、`src/gray.mjs`） | 原始层 `data/raw/2026-10-19.jsonl`（append-only，gitignored，50 批）→ 派生 `data/templates/checkpoint-flash_1017.json` + `results/watch/gray-watch.json` | **机器产物** |
| E10 Phase 0 噪声底 | 官方 flash 1017 **同一天 30 轮 / 240 批 / 8640 请求 / 0 错误**（892k token，2h07m）的自然波动：T 向量 `[18,17,17,39,16]` 240/240 唯一；L top-k Jaccard p50/p05/p95 = **0.852 / 0.786 / 1.000**（6 种取值，logprob 退化 IQR=0）；G 失败 **720/3360 = 21.4%**（CI [0.201, 0.228]，240 批恒等）；C 命中率恒 **0.889**；S TTFT p50/p95 = **128 / 235ms**（p95/p50 = 1.84）；五通道全部 `usable`，`verdict=calibrated`。据此校准 judge 阈值：`lMaxTopKJaccardDrop 0.05→0.10`、`sTtftRatio 1.5→2.5`（G/C/gray 复核后保留）——滚动回放显示旧默认值会误报 **12.4% / 1.2%** 批次，新值 0/259 触发 | 采集 `scripts/phase0-calibrate.sh`；派生 `driftmon baseline build` / `baseline noise-floor`；阈值 review `scripts/phase0-threshold-review.mjs` | 原始层 `data/raw/2026-10-20.jsonl`（240 批，append-only，gitignored）→ `data/baselines/noise-floor.json`（gitignored，可重算）→ `results/watch/gray-watch.json`（stable）+ `results/alerts/*.json`（stable） | **机器产物** |

## 复现方式

> 说明：E1–E7 的原始实验脚本位于 DSH 工作区的 `.scratch/` 与 `opencode-go/` 目录，
> **未随本仓库分发**（它们依赖具体实验环境）；本仓库可直接复现的是 E8（插件产物，滚动保留）
> 与 E9（driftmon CLI + 已固化的模板）。转录文件在 `data/raw/2026-10-17-transcripts/`。

```bash
cd <DSH_CHECKOUT>                  # 你的 DSH 检出目录（含 .scratch/、opencode-go/ 实验脚本）
python3 .scratch/opencode-fp/probe.py                              # E1
MAX_MINUTES=40 INTERVAL=20 python3 .scratch/fp-gateway/tokenizer-race.py   # E2（需等端点翻转）
MAX_MINUTES=40 INTERVAL=25 python3 .scratch/fp-gateway/logprob-race.py     # E3
MAX_MINUTES=40 INTERVAL=70 python3 .scratch/fp-gateway/glitch-battery.py   # E4
node opencode-go/collect-endpoints.mjs --sweep                      # E7
# E9 官方检查点模板（需 DEEPSEEK_API_KEY；只读原始层固化，不联网）
export DEEPSEEK_API_KEY=...
# 一轮 = K=8；模板用 5 轮（--since 圈定窗口），check 默认用最近一轮
node bin/driftmon.mjs collect --config config.official-deepseek.example.json --sessions 8   # ×5
node bin/driftmon.mjs template build --config config.official-deepseek.example.json \
  --fingerprint e72d3c7f663d3e1383b00b3884cb4501 --name "flash 1017" --since 1792434574115
node bin/driftmon.mjs template check --config config.official-deepseek.example.json
```

```bash
# E10 Phase 0 噪声底（需 DEEPSEEK_API_KEY；会花钱：30 轮 ≈ 892k token / 约 2 小时）
export DEEPSEEK_API_KEY=...
cd <driftmon>
./scripts/phase0-calibrate.sh --dry-run                          # 不花钱，先验证配置/预算
./scripts/phase0-calibrate.sh --rounds 30 --interval 60          # 断点续跑，append-only 写 data/raw/
node bin/driftmon.mjs baseline build --config config.official-deepseek.example.json
node bin/driftmon.mjs baseline noise-floor --config config.official-deepseek.example.json --rounds 30
node scripts/phase0-threshold-review.mjs --config config.official-deepseek.example.json   # 只读回放，人工 review 阈值
```

## 从这份索引得到的两条流程要求

1. **E2–E5 的四次采集脚本当时都没有落盘**——它们只 `print`。
   **Phase 0 起，任何采集都必须把原始输出写成文件**（`data/raw/`），不允许只 print。
2. **一次性内联脚本（E5/E6）不可复现**——凡是产生文档数字的探测，都必须落成脚本文件再跑。
   "先跑通再回头补脚本"在本项目里被明确禁止：**它就是证据丢失的原因。**

## 待补

| 项 | 说明 |
| --- | --- |
| E2 的完整 31 个样本值 | 转录时压缩成 `×31 全为 64`，原文含逐次数值 |
| 集群性复核 | E2–E4 均为单窗口观测，需在 Phase 0 重跑以确认可复现 |
| L 通道非平稳性 | E10 窗口内 L top-k 取值模式随时间上移（低模式 0.786 在窗口后段减少、0.923 增多；同指纹、同端点、G/C/T 完全恒定）。已按滚动基线口径计入噪声（阈值 0.10 覆盖滚动回放最大自然跌落 0.071），但是否与负载/时段相关需跨天复核 |
| 版本控制 | ✅ **已解决**（2026-10-17）：本目录、`.scratch/` 下的探测脚本与报告、`opencode-go/`、插件已随提交 `a63950c` 入库；大体积与敏感目录（`runtime/`、`.scratch/upgrade-check/` 等）连同 `home/` 一并写入 `.gitignore` |

## 会话日志的读法（E2–E6 的唯一现存出处）

会话日志：`<DSH_HOME>/sessions/<项目编码目录>/<session>/session.v4.jsonl.zstd`
（项目编码目录名由 DSH 工作区路径推导，形如 `--home-<user>-projects-<dsh-checkout>--`）。

**它是多帧 zstd 顺序拼接**：普通 `grep` 无效，Node 的 `zstdDecompressSync` 也只解第一帧
（只会拿到约 216 字节的会话头）。正确做法是按 magic `28 b5 2f fd` 切帧后逐帧解压，
再读其中的 `tool/result` 记录——E2–E6 的原始 stdout 与三个 job 的真实启动命令都在里面
（`MAX_MINUTES=40` + `INTERVAL=20 / 25 / 70`）。
