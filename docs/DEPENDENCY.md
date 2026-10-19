# 两个仓库的依赖契约

> 结论：**可以放两个仓库。** driftmon 与 `dsh-system-fingerprint` 之间是一条**只读文件契约**，
> 不是代码依赖、不是进程依赖、不是数据目录共享。

## 1. 分工

| | [`dsh-system-fingerprint`](https://github.com/Mizumic/dsh-system-fingerprint)（插件仓库） | [`driftmon`](https://github.com/Mizumic/driftmon)（本仓库） |
| --- | --- | --- |
| 角色 | 被动层：拦截真实响应、探测 `system_fingerprint`、网关溯源、端点登记表 | 主动层：定时探针组、签名、基线、判定、报告 |
| 数据 | 自己写 `$DSH_HOME/storages/system-fingerprint/`（`endpoints.json` / `config.json` / 内部产物） | 自己写 `driftmon/data/` 与 `driftmon/results/` |
| 何时运行 | 随 DSH 宿主进程常驻（默认零额外成本） | 由 cron / systemd / 手动 CLI 触发（默认不随插件启动） |
| 失败域 | 徽标显示、存证 | 采集失败、基线不可比、判定异常 |
| 依赖方向 | **不知道 driftmon 存在** | 只读插件的 `endpoints.json`（见下） |

两个仓库**都能单独成立**：driftmon 不装插件也能采集/判定（只是报告里少一条「端点是否已登记」的注释）；
插件不装 driftmon 也照常工作。

## 2. 契约：两个只读文件

### 2.1 `endpoints.json`（v1，必需）——端点登记表

```
$DSH_HOME/storages/system-fingerprint/endpoints.json
```

driftmon 只读、不写，读取位置在 `driftmon/src/plugin-dep.mjs`（driftmon 里唯一允许碰插件目录的模块）。
用到的字段：

| 字段 | 用途 | 缺失时 |
| --- | --- | --- |
| `version` | 契约版本（当前 `1`） | 告警，按已知字段继续读 |
| `endpoints[].endpointId` | 报告里标注「这个端点是否在被动层登记过」 | 标「未登记」 |
| `endpoints[].models` | 端点服务过哪些模型 | 空 |
| `endpoints[].count` / `lastSeenAt` | 累计观测次数与最近时间 | 0 / null |
| `endpoints[].lastContext` | 最近请求的会话/日志/机房 | null |

**版本策略**：插件改字段必须 bump `version`；driftmon 遇到不认识的版本只告警（`warnings`），不崩、不阻断开采。
判定层**不依赖**这个文件——`docs/DATA-MODEL.md` 的「判定必须能拿原始层重算」不会因为插件升级而失效。

### 2.2 `config.json`（v1，可选）——provider / 开关 / 当前检查点的只读导出

```
$DSH_HOME/storages/system-fingerprint/config.json
```

driftmon 用它对齐探测路由、把「行为模板」绑定到最近一次探测到的检查点
（`src/plugin-dep.mjs` 的 `loadPluginConfig`，缺失/损坏/版本不认识都只降级告警）。

| 字段 | 用途 | 缺失时 |
| --- | --- | --- |
| `version` | 契约版本（当前 `1`） | 告警，按已知字段继续读 |
| `probe.{provider,model,openaiBaseURL}` | 与 driftmon 实际探测的路由对齐（报告里标出差异） | 跳过 |
| `capture.{enabled,rawEnabled}` | 说明被动层是否在采元数据/原始字节（判定解释用） | 跳过 |
| `gateway.{hosts,sessionHeader,headers}` | 被动层如何解析网关溯源（与 driftmon `provenance` 口径互证） | 跳过 |
| `checkpoints[]` | 已知检查点表（`name` + `fingerprint`） | 空 |
| `checkpoint` | 最近一次成功探测：`{fingerprint,name,provider,model,probedAt,endpointHost,confidence}` | null |

**安全**：该文件是白名单导出，**不含凭据值、prompt、响应正文、本机绝对路径**；`probe.apiKeyEnv`
只是凭据 ref 的名字。字段只增不减，规则与 `endpoints.json` 相同。

### 2.3 可选：行为告警文件（不属于两仓库必需契约）

`driftmon template check` 会写 `results/watch/gray-watch.json`（通用 schema v1）。**插件可选读取**
它做展示（插件配置 `externalAlertFile`，路径由用户填），但：

* 插件不认识 driftmon，也不知道这个文件是谁写的；文件缺失/损坏/版本不认识静默降级；
* driftmon 不写插件目录、不 import 插件代码（只读契约仍然只有 §2.1/§2.2 两个文件）；
* 因此这**不构成**反向依赖：把 driftmon 换成任何别的告警产出方，插件照常工作。

## 3. 明确不做的耦合

* 不 import 插件代码（插件是 DSH 宿主的 bundle，不是库）；
* 不读插件的原始 SSE 存证（driftmon 的通道用自己发的探针，不重复实现被动层）；
* 不共享数据目录（插件的 raw 是滚动删除的，driftmon 的 raw 是 append-only，保留策略相反）；
* 不互相触发：driftmon 的采集不需要 DSH 正在运行，插件也不需要 driftmon 在跑。

## 4. 两个仓库的摆放建议（位置可自选）

两个仓库和 DSH 树**可以放在任意位置**，只要能找到 `DSH_HOME` 即可。
一种推荐布局（与下面「自动发现顺序」的第 3 条吻合）：

```
<projects>/
├── <dsh-checkout>/            # DSH 工作区（DSH_HOME=其下的 home/；插件产物在 home/storages/...）
└── dsh-drift/                 # 两个仓库可放同一个目录下
    ├── dsh-system-fingerprint/  # 插件仓库
    └── driftmon/                # 本仓库
```

driftmon 找到插件产物目录的顺序：

1. `config.json` 里的 `plugin.dshHome`（gitignored，参考 `config.example.json`）；
2. 环境变量 `DSH_HOME`；
3. 默认 `<driftmon>/../home`（仅当两个仓库与 DSH_HOME 并排放时才成立）。

换机器时，重新写一份 `config.json`（参考 `config.example.json`）或 `export DSH_HOME=/path/to/dsh/home` 即可。

可以用 `driftmon status` 检查是否读到了：

```
被动层依赖（dsh-system-fingerprint）：
  路径：.../home/storages/system-fingerprint/endpoints.json
  schema=v1 · 端点 2 个 · 模型 1 个 · 更新于 2026-10-17 17:03:12Z
```

读不到也不影响 driftmon 采集（`collect` / `baseline` / `judge` 都不依赖它）。

## 5. 发布解耦

* driftmon 的 `package.json` **不依赖**插件的 npm 包（现在不需要，将来也不建议加；文件契约比包依赖稳）；
* 只读契约目前有两个版本化文件（`endpoints.json` v1 / `config.json` v1），插件代码零 driftmon 引用；
* 插件的升级节奏跟 DSH 宿主走，driftmon 的升级节奏跟探针组/判定逻辑走，两者互不阻塞；
* 探针组换版由 driftmon 自己管（`probeSetVersion` + 基线 `stale`），与插件完全无关。
