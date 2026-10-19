# driftmon · 后端漂移监测

> **一句话**：在不依赖供应商声明的前提下，持续监测「我调用的模型后端有没有悄悄变」。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-64%20passing-brightgreen.svg)](#开发与测试)
[![Phase](https://img.shields.io/badge/phase-0%2F1%20skeleton-orange.svg)](#当前状态与已知限制)

**当前状态**：Phase 0/1 骨架已实现（采集 / 签名 / 基线 / 判定 / 报告 + 离线测试），
**30 轮真实噪声标定还没跑**——跑完 Phase 0 之前，判定阈值都只是默认值。
2026-10-20 起有了**已知检查点行为模板**（`data/templates/`，官方 flash 1017 已固化），
作为灰度检测与「无指纹网关反推检查点」的参考物（尚未接进 `judge`）。

## 目录

- [为什么做这个](#为什么做这个)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置](#配置)
- [已知检查点模板](#已知检查点模板灰度检测的参考物)
- [告警合并到展示层](#告警合并到展示层)
- [数据与目录约定](#数据与目录约定四层分离)
- [怎么读这套文档](#怎么读这套文档)
- [与插件仓库的关系](#与插件仓库的关系)
- [边界](#边界写在最前面防止这个项目被期待成别的东西)
- [开发与测试](#开发与测试)
- [当前状态与已知限制](#当前状态与已知限制)
- [贡献](#贡献)
- [安全](#安全)
- [变更记录](#变更记录)
- [许可证](#许可证)

## 为什么做这个

起因（2026-10-17 的实测）：把上游从 `deepseek-official` 切到 `opencode-go` 之后发现两件事——

1. **新上游根本不发布 `system_fingerprint`**，官方那条"后端配置指纹"的通道直接消失；
2. **即使回到有指纹的官方端点，那个字段也只是供应商的一句承诺**——它说没变就没变，你没有任何反证。

于是问题变成：**能不能只靠自己观测到的机械行为，判断后端有没有变？**

这件事的价值不限于 OpenCode Go：任何中转站、网关、公司内部代理都可能悄悄换后端
（OpenRouter / OrcaRouter / 各类聚合服务，换后端是常态），而客户端只有一句"我们没变"。

## 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | `>= 20` | 纯 Node 实现，**零运行时依赖**（只用内建模块） |
| API key（采集时才需要） | 环境变量 | 例如 `OPENCODE_API_KEY` / `DEEPSEEK_API_KEY`；**只走环境变量，不写进配置文件** |
| 被动层插件（可选） | [`dsh-system-fingerprint`](https://github.com/Mizumic/dsh-system-fingerprint) | 只读它的产物做交叉引用；不装也能采集/判定 |

## 快速开始

```bash
git clone https://github.com/Mizumic/driftmon.git
cd driftmon
npm test                                  # 64 项离线测试，不联网
node bin/driftmon.mjs status              # 配置 / 探针组哈希 / 插件依赖 / 数据现状

export OPENCODE_API_KEY=...               # key 只走环境变量，不写配置文件
node bin/driftmon.mjs collect --sessions 1 --only T,L,G,S   # 冒烟：partial 批次，不进判定
node bin/driftmon.mjs collect --sessions 8                  # 一轮巡检（≈4.7k token/会话）

node bin/driftmon.mjs baseline build      # 滚动窗口 → data/baselines（按端点分组）
node bin/driftmon.mjs judge run           # 同端点内部比基线 → results/alerts
node bin/driftmon.mjs report              # 人可读报告 → results/reports

# 已知检查点的行为模板（官方端点用 system_fingerprint 认定检查点后固化；见 data/templates/）
node bin/driftmon.mjs template build --fingerprint <官方 system_fingerprint> --name "flash 1017"
node bin/driftmon.mjs template check          # 最新窗口对模板比较 → results/watch/gray-watch.json
```

## 配置

配置文件：复制 [`config.example.json`](config.example.json) 为 `driftmon/config.json`（gitignored）。
官方端点采集另见 [`config.official-deepseek.example.json`](config.official-deepseek.example.json)。

关键约定：

* **key 永远走环境变量**：配置里只写 `apiKeyEnv`（环境变量名），不写明文。
* **被动层存储目录解析顺序**：`config.json` 的 `plugin.dshHome` → 环境变量 `DSH_HOME` →
  默认 `<driftmon>/../home`（仅当与 DSH 树并排放置时成立）。换机器时写一份 `config.json`
  或 `export DSH_HOME=/path/to/dsh/home` 即可。
* **所有判定阈值在 `judge.thresholds` / `gray.thresholds`**，Phase 0 标定后按
  `data/baselines/` 的噪声底替换；标定前不要拿默认值当对外结论。
* 探针组冻结在 [`probes/probe-set.json`](probes/probe-set.json)（`probeSetVersion` +
  `probeSetHash`）；换探针组必须重采基线、重建模板。

## 已知检查点模板（灰度检测的参考物）

官方端点的 `system_fingerprint` 是「检查点」的权威标识；把同一检查点在冻结探针组下的行为签名
（T/L/G/C/S）固化成**模板**，作为以后比较的参考物：

* **官方灰度检测**：指纹没变、但行为通道相对模板偏移或出现双峰 → 疑似灰度/静默变更；
  `T/C/S` 偏移更像配置/服务栈变化，`L top-k` / `G` 偏移更像权重变化。
* **无指纹网关反推**：网关不返回指纹时，用行为签名对模板挑最接近的检查点。

已固化：`data/templates/checkpoint-flash_1017.json`（2026-10-20 官方端点 **5 轮完整巡检**
= 40 批 / 1440 样本 / 0 错误；T 向量 `[18,17,17,39,16]` 40/40 一致、G 失败 3/14 且集合 40/40 一致、
L top-k 中位 0.819、C 命中 0.889、TTFT 中位 117ms；L 的 logprob 数值退化为 0，只用 top-k 集合）。
`template check` 用最近一轮对模板比较 → `results/watch/gray-watch.json`（当前 `stable`）。
重建方法与限制见 [`data/templates/README.md`](data/templates/README.md)。

> 边界：模板对比（`template check`）已经能产出 `gray-candidate`/`checkpoint-change` 等告警，
> 但**判定阈值仍是默认值、需要 Phase 0 标定**；灰度是否可测取决于它是否改变这些可测量分布。

## 告警合并到展示层

`template check` 写 `results/watch/gray-watch.json`（通用 schema v1，不绑定具体宿主）。
[`dsh-system-fingerprint`](https://github.com/Mizumic/dsh-system-fingerprint) 可选配置
`externalAlertFile` 指向它：warn/critical 时提醒合并进指纹徽标（`⚠` + 警示色），详情进悬浮卡片。
插件不感知 driftmon；文件缺失/损坏静默降级。这个文件属于**可选展示契约**，
不属于两个仓库必需的文件契约（后者见 [`docs/DEPENDENCY.md`](docs/DEPENDENCY.md)）。

## 数据与目录约定（四层分离）

```
driftmon/
├── README.md              ← 你在这里：定位、怎么读
├── bin/driftmon.mjs       ← CLI 入口
├── config.example.json    ← 配置样例（config.json 不入库）
├── config.official-deepseek.example.json  ← 官方 DeepSeek 端点采集/模板配置样例
├── package.json
├── docs/                  ← ① 文档层：设计与前置知识（人写、可评审）
│   ├── DESIGN.md          ← 设计文档：目标、边界、架构、判定规则、开放问题
│   ├── PREREQUISITES.md   ← 前置知识：实测得到的硬事实与陷阱（写实现前必须读）
│   ├── DATA-MODEL.md      ← 四层数据结构的字段定义与不变量
│   ├── DEPENDENCY.md      ← 与 dsh-system-fingerprint 的两仓库依赖契约
│   └── ROADMAP.md         ← 阶段划分与验收标准
├── probes/                ← ② 配置层：探针组的定义（数据，不是代码）
│   ├── probe-set.json     ← 冻结探针组（T/L/G/C/S 五组共 22 条探针 / 36 请求）
│   ├── cache-prefix.txt   ← C 组固定长前缀（字节由 promptSha256 锁定）
│   ├── glitch-tokens.json ← G 组 token 清单与来源/置信度
│   └── NOTES.md           ← 冻结规则、来源、已知缺口、冒烟实测
├── src/                   ← ③ 代码层：采集 / 签名 / 基线 / 判定 / 报告（纯 Node，无外部依赖）
├── data/                  ← ④ 原始数据层：append-only，不删不改
│   ├── raw/               ← 每次采样的原始输出（数值摘要 + 端点溯源 + 官方 system_fingerprint；不存 prompt / 响应正文）
│   ├── baselines/         ← 滚动基线：每通道的分布统计
│   └── templates/         ← 已知检查点行为模板（派生参考：T/L/G/C/S 签名；从 raw 重建）
├── results/               ← ⑤ 判定层：结论（人可读报告 + 机器可读告警）
│   ├── reports/
│   ├── alerts/
│   └── watch/             ← 行为告警（模板对比 → gray-watch.json，可被展示层读取）
└── test/                  ← 离线测试（node:test；桩 fetch，不联网）
```

> 注：本目录树用 ①–⑤ 数**五个目录层**；`docs/DATA-MODEL.md` 里的"层①②③④"是**数据语义层**
> （原始 / 签名 / 基线 / 判定），其中签名层是纯函数派生、**刻意不给独立目录**。两套编号含义不同，不要混读。

**为什么要分这么细**：这个窗口在**端点登记表**上踩过一次坑——第一版采集器是"每次重建"，
重跑一次就把上次扫描的成果冲掉了（那轮新发现 17 个、登记表总数 19）。教训是**原始观测、派生摘要、判定结论必须分开存**：
前者不可再生，后者随时可重算。driftmon 把这条当硬约束。

**数据不入库**：`data/raw/*.jsonl`、`data/baselines/*.json`、`results/alerts|watch|reports/*`
都是本机生成物（见 `.gitignore`），随用随弃、可重算；入库的是探针定义、模板、文档与代码。
`data/raw/2026-10-17-transcripts/` 是早期人工转录，用于追溯实测结论的来源，**不是**机器产物。

## 怎么读这套文档

| 你想干什么 | 读哪份 |
| --- | --- |
| 决定要不要做、做成什么样 | [`docs/DESIGN.md`](docs/DESIGN.md) |
| 动手改代码之前 | [`docs/PREREQUISITES.md`](docs/PREREQUISITES.md)（**必读**，全是实测结论和坑） |
| **想知道文档里的数字是哪来的** | [`docs/EVIDENCE.md`](docs/EVIDENCE.md)（证据索引：脚本 / 产物 / 复现命令 / 可信度） |
| 想知道两个仓库怎么放、接口是什么 | [`docs/DEPENDENCY.md`](docs/DEPENDENCY.md) |
| 设计数据结构 / 改字段 | [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) |
| 想知道先做什么、做到什么算完成 | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| 动探针之前 | [`probes/NOTES.md`](probes/NOTES.md)（冻结规则 + 来源 + 已知缺口） |
| 想看第一手观测 | [`data/raw/2026-10-17-transcripts/`](data/raw/2026-10-17-transcripts/)（**转录，非机器产物**，用前请重跑复核） |

## 与插件仓库的关系

本项目是**两个独立仓库**：

| 仓库 | 角色 |
| --- | --- |
| [`Mizumic/dsh-system-fingerprint`](https://github.com/Mizumic/dsh-system-fingerprint) | **被动层**（DSH 插件）：拦截真实响应、探测 `system_fingerprint`、网关溯源、端点登记表 |
| `Mizumic/driftmon`（本仓库） | **主动层**：定时探针组、签名、基线、漂移判定、报告、行为模板与告警 |

两个仓库互不 import 代码，只靠**只读文件契约**相连：driftmon 只读插件的
`$DSH_HOME/storages/system-fingerprint/endpoints.json`（v1，必需）与 `config.json`（v1，可选），
缺失/损坏/版本不认识都只降级告警。契约细节见 [`docs/DEPENDENCY.md`](docs/DEPENDENCY.md)。

## 边界（写在最前面，防止这个项目被期待成别的东西）

* **它是观测，不是断言**：只能告诉你「某个可测量的东西变了」，说不出「变成了什么」。
* **供应商不改指纹又只换权重、不换 tokenizer 时，各通道都很弱**，此时只有统计置信度。
* **不做内容质量评测**：任务正确性、风格、工具调用能力属于另一件事，不在这里。
* **不存 prompt / 响应正文**：只存数值摘要与（脱敏后的）响应头。
* **主动监测不默认常驻**：插件不会自动跑它；要采就显式跑 CLI（cron / systemd / 手动）。

## 开发与测试

```bash
npm test                     # 64 项离线测试（node --test；桩 fetch，不联网）
npm run status               # 等价于 node bin/driftmon.mjs status
node bin/driftmon.mjs probe-set hash   # 查看冻结探针组哈希
```

约定：

* **纯 Node、零依赖**：`src/` 只 import `node:` 内建模块；不引入第三方运行时依赖。
* **原始层 append-only**：采集只追加 `data/raw/*.jsonl`，不修改历史；派生层（baseline /
  template / alert / report）随时可从原始层重算。
* **证据先落盘**：任何产生文档数字的探测都必须由脚本写出文件，禁止「只 print」和一次性内联脚本
  （见 [`docs/EVIDENCE.md`](docs/EVIDENCE.md)）。
* **探针组冻结**：改 `probes/` 必须 bump `probeSetVersion`，并重建基线/模板；`probeSetHash`
  不一致时拒绝比较。
* **key 不进代码/配置/日志**：只从环境变量读。

## 当前状态与已知限制

* Phase 0/1 骨架完成，**Phase 0 的 30 轮真实噪声标定未跑**：`judge` 阈值均为默认值，
  `drift-confirmed` 只用于结构验证，不能当作对外结论。
* `template check` 的灰度阈值同为默认值（`config.gray.thresholds`），`gray-candidate` 只是「疑似」，
  需要连续复现。
* 行为模板 ≠ 版本识别：模板只能回答「行为是否偏离已知检查点」，不能证明具体版本。
* 真实网关单会话冒烟已跑通；完整 5 轮官方巡检数据见 `docs/EVIDENCE.md`（E9）。

## 贡献

欢迎 issue / PR。开始前请读 [`CONTRIBUTING.md`](CONTRIBUTING.md)：开发流程、
测试要求、探针/数据层硬约束。行为准则见 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。

## 安全

本项目处理 API key 与模型响应证据：key 只走环境变量；不存 prompt / 响应正文。
安全问题请**不要**开公开 issue，按 [`SECURITY.md`](SECURITY.md) 的渠道私下报告。

## 变更记录

见 [`CHANGELOG.md`](CHANGELOG.md)。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 许可证

[MIT](LICENSE) © 2026 Mizumic
