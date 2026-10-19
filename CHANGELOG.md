# 变更记录（Changelog）

本文件格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

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
- **离线测试** 64 项（`node --test`，桩 fetch，不联网）。

### Changed

- 数据层四层分离硬约束：原始层 append-only、派生层随时可重算。
- 本仓库与插件仓库的只读文件契约写入 `docs/DEPENDENCY.md`（单向依赖，不做代码耦合）。

### Known limitations

- Phase 0 的 30 轮真实噪声标定**尚未运行**，`judge` / `gray` 阈值均为默认值，
  标定前不得把判定当作对外结论。
- 行为模板尚未接进 `judge`；「无指纹网关反推检查点」尚未实现。
