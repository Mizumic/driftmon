# DSH Agent 安装指南（driftmon）

> **面向对象**：在 DSH（DeepSeek Harness）环境里替用户安装/配置/验证 driftmon 的 **agent**。
> 人类部署也可以照做，只是本指南刻意写成「可逐步验证、失败可回滚」的 agent 流程。
>
> **两个前置文档**：
> * [`SYMBOLS.md`](SYMBOLS.md)：本机符号映射表（`${DSH_HOME}`、`${WATCH_FILE}` 等），
>   实际取值放 `.local/symbols.env`（gitignored）；
> * [`DEPENDENCY.md`](DEPENDENCY.md)：与插件仓库的只读文件契约。

## 0. 适用范围与前置条件

| 项 | 要求 | 检查命令 |
| --- | --- | --- |
| Node.js | `>= 20` | `node -v` |
| 仓库 | 已 clone 到 `${REPO_DIR}`，工作区干净 | `git -C "${REPO_DIR}" status --short` |
| 网络 | 仅真实采集/模板重采需要；离线测试不需要 | — |
| 凭据 | 只需**环境变量名**（配置项 `provider.apiKeyEnv`） | 询问用户用哪个端点/key |
| 被动层插件（可选） | 装了才能读端点登记/检查点；不装也能跑 | 见插件仓库 `docs/AGENT-INSTALL.md` |

> 变更范围：写 `${DRIFTMON_DIR}/config.json`（本机配置）与 `data/`、`results/`（产物）。
> **真实采集会消耗 token**（一轮 K=8 约 4.7k token/会话）——先问用户，再跑。

## 1. 初始化符号映射（agent 第一步）

```bash
cd "${REPO_DIR}"
mkdir -p .local
[ -f .local/symbols.env ] || cp docs/symbols.example.env .local/symbols.env
set -a; . .local/symbols.env; set +a
```

自检：

```bash
node -v                                             # v20+
echo "${DSH_HOME:?缺少 DSH_HOME}"                   # 用于默认定位插件产物
test -f probes/probe-set.json && echo repo-ok
```

解析规则见 [`SYMBOLS.md`](SYMBOLS.md) §3：**推不出来就问用户，不要猜路径写进配置**。

## 2. 离线验证（不联网、失败即中止）

```bash
npm test            # 等价于 node --test test/*.test.mjs
```

期望：**71 项全过**。不通过就停下报告，不要继续配置。

## 3. 配置

```bash
[ -f "${CONFIG_FILE}" ] || cp config.example.json "${CONFIG_FILE}"
```

按用户环境改 `${CONFIG_FILE}`（**gitignored，不要提交**）：

| 配置 | 填法 |
| --- | --- |
| `plugin.dshHome`（可选） | 填 `${DSH_HOME}`；留空则按 `DSH_HOME` 环境变量 → `<repo>/../home` 解析 |
| `provider.*` | 端点 `baseURL` / `model` / `apiKeyEnv`（**只写环境变量名**，如 `OPENCODE_API_KEY` 或 `DEEPSEEK_API_KEY`） |
| `collect.sessions` | 一轮巡检用 8；冒烟用 1 |
| `judge.thresholds` / `gray.thresholds` | **保持默认**，除非用户明确要求并理解 Phase 0 尚未标定 |

凭据只放环境变量：例如 `export OPENCODE_API_KEY=...`（不要让用户把值发给 agent / 写进文件）。

## 4. 验证（逐条给证据）

| # | 检查 | 命令 | 期望 |
| --- | --- | --- | --- |
| 1 | 配置/探针组/依赖读取 | `node bin/driftmon.mjs status` | 打印探针组 version + hash；插件依赖段显示路径/schema/端点/模型 |
| 2 | 探针组哈希 | `node bin/driftmon.mjs probe-set hash` | 与 `probes/probe-set.json` 一致 |
| 3 | 数据现状 | `status` 的「原始层 / 基线」段 | 空基线是正常的（先跑 baseline build） |
| 4 | 冒烟（消耗少量 token，需用户同意） | `node bin/driftmon.mjs collect --sessions 1 --only T,L,G,S` | 产物批次标 `partial: true`，**不参与判定** |
| 5 | 插件联动（若装了插件） | `status` 的「被动层依赖」段 | 显示「只读配置 v1」与当前检查点（如 `flash 1017 · e72d3c7f…`） |

> agent 不要用冒烟批次去标定阈值/建模板；正式数据必须来自完整探针组。

## 5. 正式工作流（用户明确要求后再跑）

```bash
# 一轮完整巡检（K=8，约 4.7k token/会话；按需 --config 指定端点配置）
node bin/driftmon.mjs collect --sessions 8
# 派生层（不联网、可重算）
node bin/driftmon.mjs baseline build
node bin/driftmon.mjs judge run
node bin/driftmon.mjs report
# 行为模板（官方端点：先用 system_fingerprint 认定检查点）
node bin/driftmon.mjs template check   # → ${WATCH_FILE}
```

数据层不变量：`${RAW_DIR}` append-only；派生层随时可从原始层重算；改探针组必须 bump
`probeSetVersion` 并重建基线/模板（见 [`DATA-MODEL.md`](DATA-MODEL.md)）。

## 6. Phase 0 噪声标定（可选、会花钱；先读 [`PHASE0-PLAN.md`](PHASE0-PLAN.md)）

> 这是「让阈值可信」的前提，**不是安装必需**。真正采集前必须先得到用户明确授权：
> 30 轮 ≈ 2 小时、≈1.1–1.4M token、≈$0.36；key 只从环境变量读。

1. dry-run（不花钱）：`./scripts/phase0-calibrate.sh --dry-run`
2. 冒烟（可选，~38k token）：`node bin/driftmon.mjs collect --sessions 1 --only T,L,G,S`
   （产物标 `partial`，不进基线/噪声底，只验证 key/网络/解析）
3. 30 轮采集：`./scripts/phase0-calibrate.sh --rounds 30 --interval 60`
   （可后台 `nohup`；断点续跑；日志在 `.local/phase0/`）
4. 派生：`baseline build` → `baseline noise-floor --rounds 30` → 检查 `summary.verdict === "calibrated"`、
   每个端点 `channels.T.distinctVectors === 1`、`unusableChannels` 是否合理
5. 阈值 review：**人工**按 noise-floor 数值改 `judge.thresholds` / `gray.thresholds`，不要自动改配置
6. 固化：`EVIDENCE.md` 记 E10、`ROADMAP.md` 勾 Phase 0、`CHANGELOG.md` 记录；重跑
   `template check` / `judge run`，无漂移时应是 `stable`/`insufficient` 而非 `drift-*`

## 7. 与插件仓库联动（可选）

让插件展示 driftmon 的行为告警：在插件的 profile 配置里设置
`externalAlertFile: ${WATCH_FILE}`（插件侧 `display-only`，文件缺失静默降级）。
反向不做：driftmon 不写插件目录、不 import 插件代码。

## 8. 定时化（需用户同意）

cron 示例（时间/路径按 `${SYMBOLS}` 展开后写入用户 crontab，不要提交真实路径）：

```cron
# 每天 09:10 跑一轮巡检 → 基线 → 判定 → 报告 → 模板对比
10 9 * * * cd ${DRIFTMON_DIR} && set -a && . .local/symbols.env && set +a && node bin/driftmon.mjs collect --sessions 8 && node bin/driftmon.mjs baseline build && node bin/driftmon.mjs judge run && node bin/driftmon.mjs report && node bin/driftmon.mjs template check
```

systemd timer 同理（`ExecStart=/usr/bin/env bash -lc '…'`）。安装/修改计划任务前先问用户。

## 9. 安全边界（硬约束，agent 不得违反）

1. **凭据**：只通过环境变量名引用；不读取、不打印、不写入、不提交任何 key。
2. **数据**：不存 prompt / 响应正文；`${RAW_DIR}` append-only，不修改历史批次。
3. **成本**：真实采集消耗 token；未经用户同意不跑完整巡检。
4. **本机字段**：只写符号或 `.local/symbols.env`；不要把绝对路径写进仓库文件/提交。
5. **不替用户做判定结论**：Phase 0 标定前阈值只是默认值，报告要写明。

## 10. 常见失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `status` 显示插件依赖读取失败 | 没装插件 / `${DSH_HOME}` 不对 | 跳过即可；或修 `plugin.dshHome` |
| `collect` 401/403 | `apiKeyEnv` 指名的环境变量未设置/失效 | 让用户设置环境变量，不要把 key 写进配置 |
| `judge` 报基线不可比 | 探针组换版 / 端点数不足 | 重建 baseline；检查 `probeSetHash` |
| `template check` 拒绝比较 | `probeSetHash` 不一致 | 模板与探针组绑定：换探针组必须重采重建 |
| 批次 `partial: true` 被当作正式数据 | 冒烟采集不进判定 | 完整探针组重采 |
