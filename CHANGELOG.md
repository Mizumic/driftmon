# 变更记录（Changelog）

本文件格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **T 通道官方参照（2026-10-20，E11）**：用官方开源的 `deepseek-recipe` 0.2.0 + 自带 v41 tokenizer
  离线算出冻结探针组的期望 `prompt_tokens`，固化成入库工件
  `data/reference/official-tokenizer-v41.json`（tokenizer 由 SHA-256 锁定、登记包版本与源码 commit）。
  新增 `src/tokenizer-reference.mjs`（工件自检 + 窗口比对纯函数）、`driftmon reference check`
  （实测 T 向量 vs 官方参考 → `results/reference/tokenizer-check.json`），`status` 与
  `template check` 增加参照摘要；新增 `scripts/build-tokenizer-reference.py`（dev-only，Python +
  `deepseek-recipe`，不进运行时）与 `docs/TOKENIZER-REFERENCE.md`。**实测**：5 条 T 探针期望
  `[18,17,17,39,16]` 与 E9/E10 的 240/240 实测**逐项一致** → `flash 1017` 模板的 T 向量获得官方实现
  背书；`t-special` 的 prompt/完整词表编码差（39 vs 29）验证了 special-token 防注入语义。
  测试 71 → **77 项**（新增工件/比对/CLI 端到端断言）。
- **上游参考实现更新检查**：`scripts/check-upstream.mjs` + `npm run upstream:check`——只读检查
  `deepseek-recipe` main/commit、v41 tokenizer blob、`DeepInfer` main 是否偏离仓库记录的基线；
  有变化退出 1 并给出处理指引（T 参照刷新纪律见 `docs/TOKENIZER-REFERENCE.md` §4–§5）。
- **官方参考实现的思路引用**：`docs/PREREQUISITES.md` 新增 §7——把 DeepInfer / deepseek-recipe
  中与判定相关的官方事实（默认 checkpoint 身份、batch-invariant 与确定性、跨平台数值差异、
  会改变行为但不改权重的开关清单、YoCo 截断、KV cache 语义、V4/V4.1 能力差异）映射到本项目的
  通道与归因逻辑；**明确不运行 DeepInfer、不作运行时依赖**。
- **T 核验结论固化进检查点模板（2026-10-20）**：`template build` 把官方参照的核验结果写入模板的
  `officialReference` 块（`package` / `version` / `sourceCommit` / `tokenizerSha256` / `probeSetHash` /
  `expectedVector` / `vectorMatch` / `checkedAt`）；`template check` 输出「模板记录 / 当前窗口」两行
  核验状态。**不改 verdict、不改 `gray-watch.json` schema**；旧模板（无该块）仍合法；工件缺失或与
  当前探针组不匹配时跳过该块、不阻断构建。新增 `template build --until` 用于圈定重建窗口；
  `flash 1017` 模板已重建（窗口统计与 E9 **逐字段一致**，仅新增 `officialReference`，
  `vectorMatch=true`）。测试 77 → **78 项**。
- **Phase 0 阈值 review 回放工具**：`scripts/phase0-threshold-review.mjs`（只读、不联网、不写文件）——
  以「每条批次之前 30 批」为滚动基线回放原始层，统计 L drop / S ratio / G z / C drop 在各候选阈值下
  会触发多少批，供人工把判定阈值从默认值换成噪声底推导值；不参与判定链。

### Changed

- **T 通道官方参照接入现有命令与文档**：`status` 显示工件摘要与最近一次核验结果；
  `template check` 在输出里追加一行官方 T 参照状态（无工件时静默跳过，**不改 gray-watch.json
  schema，不影响既有展示契约**）；README 增加「T 通道官方参照」一节、目录与测试徽章更新
  （71 → 77）；`docs/EVIDENCE.md` 新增 E11 与复现命令；`docs/DATA-MODEL.md` 新增
  `data/reference/` + `results/reference/` 的字段与不变量。运行时仍纯 Node、零依赖。

### Changed

- **`checkpoint-change` 告警升级为 critical（标红）**：`template check` 检测到
  `system_fingerprint` 与模板不同时，告警文件 `level` 由 `warn` 改为 `critical`——
  指纹变化是「确定发生」的检查点切换，展示层（如 dsh-system-fingerprint 徽标）直接标红；
  行为疑似（`gray-candidate`）与配置变化（`config-change`）仍为 `warn`（黄色），
  `infra-change` 仍为 `info`（不变色）。测试断言同步更新（71 项全过）。
- **Phase 0 噪声标定完成（2026-10-20，官方 flash 1017）**：同一天连跑 **30 轮 / 240 批 / 8640 请求 /
  0 错误**（892k token，2h07m），`baseline noise-floor` 输出 `summary.verdict=calibrated`、
  `window.rounds=30`、T 向量 240/240 唯一、五通道全部 `usable`（数据见 `docs/EVIDENCE.md` E10）。
  据此校准判定阈值：`judge.thresholds.lMaxTopKJaccardDrop` **0.05 → 0.10**、
  `judge.thresholds.sTtftRatio` **1.5 → 2.5**——滚动回放显示旧默认值在正常数据上会误报
  12.4% / 1.2% 批次，新值 0/259 触发；`gZScore` / `cHitRatioDrop` / `gray.thresholds.*`
  复核后保留（G 失败率与 C 命中率在噪声底里是常数）。修后 `template check` 与 `judge run`
  复跑均 `stable`；测试仍 71 项全过。
- **开源发布准备**：README 重写为 GitHub 发布标准结构（新增目录、环境要求、配置、开发与测试、
  相关仓库、贡献/安全/许可证入口）；新增 `CONTRIBUTING.md`、`SECURITY.md`、
  `CODE_OF_CONDUCT.md`、`CHANGELOG.md`、GitHub Actions CI、issue/PR 模板、`CODEOWNERS`、
  dependabot 配置；`package.json` 增加 `repository` / `homepage` / `bugs` / `keywords`
  并移除 `private`；文档里的本机绝对路径改为通用写法。运行时行为无变化。
- **CI 维护**：GitHub Actions 升级到 `actions/checkout@v7` / `actions/setup-node@v7`
  （消除 Node 20 runner 弃用告警）；README 增加 CI 状态徽章。
- **DSH agent 安装文档 + 本机符号映射**：新增 `docs/AGENT-INSTALL.md`（agent 安装/配置/验证/
  成本与安全边界）与 `docs/SYMBOLS.md`（`${DSH_HOME}`、`${WATCH_FILE}` 等本机字段的符号映射表，
  实际取值放 gitignored 的 `.local/symbols.env`）；主仓迁移为 GitHub。
- **DSH 版本声明**：README 增加「DSH 版本声明」（driftmon 不依赖 DSH 版本，仅通过插件产物契约 v1 间接耦合；验证组合 DSH `0.2.0-rc.2` + 插件 `0.3.0`）；`docs/DEPENDENCY.md` 增加「DSH 版本耦合」一节，`docs/AGENT-INSTALL.md` 前置条件同步说明。
- **文档澄清**：`docs/SYMBOLS.md` 最后一列明确标注「示例（占位，非本机值）」，`docs/symbols.example.env` 头部也强调全部是占位符（`docs/DEPENDENCY.md` 布局示例同步标注）——避免把示例路径误读为「本机映射被入库」。真实映射只在 gitignored 的 `.local/symbols.env`。
- **Phase 0 标定工具**：新增 `baseline noise-floor` 命令——按端点/通道汇总
  自然波动（T 唯一性、L top-k p50/p95、G 失败率+CI、C 命中率、S TTFT），逐通道标注可用性
  并写 `data/baselines/noise-floor.json`；新增 `scripts/phase0-calibrate.sh`（30 轮、dry-run、
  断点续跑、日志/状态在 `.local/phase0/`）、`docs/PHASE0-PLAN.md`（runbook：成本/时间、
  阈值 review、验收映射）；测试 64 → **71 项**。

## [0.1.0] - 2026-10-20

### Added

- **Phase 0/1 骨架（纯 Node、零运行时依赖）**：
  - `collect`：K 个新会话 × 冻结探针组采集（T/L/G/C/S 五组，22 条探针 / 36 请求）；
  - `signature`：五通道纯函数签名（T 向量 / L top-k / G 失败率 / C 命中 / S TTFT）；
  - `baseline`：按端点分组的滚动基线；
  - `judge`：五值状态机（可回放原始层）；
  - `report`：人可读报告。
- **冻结探针组** `probes/probe-set.json`（`probeSetVersion` + `probeSetHash`），
  含 C 组固定长前缀与 G 组 glitch token 清单。
- **被动层只读依赖**：只读 `dsh-system-fingerprint` 的 `endpoints.json`（v1）与
  `config.json`（v1），缺失/损坏/版本不认识只降级告警（`src/plugin-dep.mjs`）。
- **官方端点采集**：`direct:<provider>` 合成端点归一化（官方直连批次可进基线/判定）；
  兼容官方 `usage.prompt_cache_hit_tokens` 字段。
- **已知检查点行为模板**：`template build` / `template check`；
  已固化 `data/templates/checkpoint-flash_1017.json`（2026-10-20 官方端点 5 轮巡检 =
  40 批 / 1440 样本 / 0 错误）。
- **行为告警**：`src/gray.mjs` 对比模板 → `results/watch/gray-watch.json`
  （通用 schema v1，display-only，可被展示层读取）。
- **离线测试** 71 项（`node --test`，桩 fetch，不联网）。

### Changed

- 数据层四层分离硬约束：原始层 append-only、派生层随时可重算。
- 本仓库与插件仓库的只读文件契约写入 `docs/DEPENDENCY.md`（单向依赖，不做代码耦合）。

### Known limitations

- Phase 0 的 30 轮真实噪声标定**尚未运行**，`judge` / `gray` 阈值均为默认值，
  标定前不得把判定当作对外结论。
- 行为模板尚未接进 `judge`；「无指纹网关反推检查点」尚未实现。
