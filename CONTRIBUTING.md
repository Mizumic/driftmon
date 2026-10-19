# 贡献指南（Contributing）

感谢你愿意改进 `driftmon`。这个项目对**数据层不变量**、**探针组冻结**和**证据可复现**有硬约束，
开始之前请先读完本文件。

## 环境准备

| 项 | 要求 |
| --- | --- |
| Node.js | `>= 20`（CI 在 20 / 22 上跑） |
| API key（仅真实采集需要） | 环境变量，例如 `OPENCODE_API_KEY` / `DEEPSEEK_API_KEY` |

```bash
git clone https://github.com/Mizumic/driftmon.git
cd driftmon
npm test          # 71 项离线测试，不联网
node bin/driftmon.mjs status
```

`npm test` 使用桩 fetch，不发起网络请求，也不需要 API key。
提交 PR 前必须让 `npm test` 全绿。

## 可以做什么

- 修 bug、补测试、改进文档、新增判定规则（附离线测试）。
- 新增探针/通道时，先参照 [`docs/PREREQUISITES.md`](docs/PREREQUISITES.md) 的实测结论与陷阱，
  再动 `probes/`（需要 bump `probeSetVersion` 并重建基线/模板）。

## 硬约束（会被测试或评审拒绝）

1. **零运行时依赖**：`src/` 只 import `node:` 内建模块，不引入第三方包。
2. **数据层不可越界**：`data/raw/` **append-only**（不修改、不删除历史批次）；
   baseline / template / alert / report 等派生层必须能从原始层重算。
3. **证据先落盘**：任何产生文档数字的探测都必须由脚本把原始输出写成文件，
   禁止「只 print」或一次性内联脚本（见 [`docs/EVIDENCE.md`](docs/EVIDENCE.md)）。
4. **探针组冻结**：改 `probes/` 必须 bump `probeSetVersion`；`probeSetHash` 不一致时
   拒绝模板比较（`template check` 会直接拒绝）。
5. **key 不进代码/配置/日志**：只从环境变量读取，`apiKeyEnv` 只是环境变量名。
6. **不存 prompt / 响应正文**：原始层只存数值摘要、端点溯源与（脱敏后的）响应头。
7. **不提交本机生成物**：`data/raw/*.jsonl`、`data/baselines/*.json`、`results/**/*.json|md`
   都在 `.gitignore` 里；也不要提交 `config.json`（本机配置）与 `.env`。

## 本地开发

```bash
node bin/driftmon.mjs status            # 配置 / 探针组 / 插件依赖 / 数据现状
node --test test/*.test.mjs             # 与 npm test 等价
node --test test/gray.test.mjs          # 单文件
```

真实采集需要联网与 key：

```bash
export OPENCODE_API_KEY=...
node bin/driftmon.mjs collect --sessions 1 --only T,L,G,S   # 冒烟，产物标 partial，不进判定
```

> 真实采集会消耗 token（一轮 K=8 约 4.7k token/会话）；冒烟批次不要用来标定阈值。

## 提交与 PR

- 提交信息建议用 `feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:` 前缀。
- 一个 PR 只做一件事；行为变更请附带测试与文档改动。
- 提交前自查：

  - [ ] `npm test` 全过
  - [ ] 没有凭据 / `.env` / 本机绝对路径 / 采集数据
  - [ ] 原始层未被修改（append-only）或缺少来源
  - [ ] 改探针组时已 bump `probeSetVersion` 并说明影响
  - [ ] 用户可见行为变化已写入 `CHANGELOG.md`

## 行为准则

参与本项目即表示同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要开公开 issue。
