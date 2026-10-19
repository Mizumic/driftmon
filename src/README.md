# src/ · 代码层（Phase 0/1 骨架已实现）

纯 Node（>=20）ESM，**不引入任何外部依赖**——两个仓库分开后，driftmon 可以直接搬走单独发布。

## 模块职责

| 文件 | 职责 | 明确不做什么 |
| --- | --- | --- |
| `probe-set.mjs` | 读 `probes/probe-set.json`，校验 C 组前缀、算 `probeSetHash`、展开探针 | 不判定 |
| `plugin-dep.mjs` | 只读 `dsh-system-fingerprint` 的 `endpoints.json`（必需）与 `config.json`（可选）（契约见 `docs/DEPENDENCY.md`） | 不写插件目录、不 import 插件代码；缺失/版本不认识只降级告警 |
| `collect.mjs` | K 个新会话 × 冻结探针组，记录原始样本到 `data/raw/`（append-only） | 不判定、不聚合 |
| `signature.mjs` | 原始批次 → 数值签名（纯函数，可重算） | 不读基线、不联网 |
| `baseline.mjs` | 滚动窗口聚合 → `data/baselines/`；按端点分组算噪声底 | 不跨端点混合 |
| `noise-floor.mjs` | Phase 0 噪声底：按端点/通道汇总自然波动、标注可用性 → `data/baselines/noise-floor.json` | 不自动改阈值、不跨端点混池 |
| `judge.mjs` | 状态机：`insufficient` / `stable` / `route-change` / `drift-candidate` / `drift-confirmed` | 不猜「变成了什么」 |
| `report.mjs` | 判定 → 人可读报告（附插件端点登记信息） | 不隐藏阴性结果 |
| `paths.mjs` | 数据目录与 append-only 写入原语 | 不碰派生层语义 |
| `config.mjs` | 默认值 + `config.json` + CLI 覆盖 | 不存 key |
| `cli.mjs` | CLI 命令编排 | 不含采集/判定逻辑 |

## 硬约束（改代码前先读 `docs/DATA-MODEL.md` 的四条不变量）

1. 探针组指纹不一致 → **拒绝比较**，直接报错，不要"尽力而为"地比。
2. **先按 `endpointId` 分组**再统计；跨端点差异归 `route-change`。
3. 原始层与派生层**不得重复计数**。
4. 每条判定必须带 `baselineVersion` + `probeSetHash` + 时间窗 + 阈值。

## 还没实现（Phase 0 之后）

* 真实 30 轮噪声标定（工具已就绪：`baseline noise-floor` + `scripts/phase0-calibrate.sh` +
  `docs/PHASE0-PLAN.md`；`docs/ROADMAP.md` Phase 0 的验收项仍在等数据）；
* 时间序列/变点检测（Phase 3）；
* 跨供应商探针组（Phase 4，需要按协议重冻结探针组）；
* 自动调度（默认不常驻；建议外部 cron / systemd 调 `driftmon collect`）。

## 测试

```bash
cd driftmon && npm test
```

71 项离线测试（`node:test`）：探针哈希/冻结、签名五通道、基线分组、**Phase 0 噪声底
（通道可用性/窗口/端点隔离）**、判定状态机（含「跨端点 → route-change 而不是 drift-candidate」
的回放用例）、采集端到端（桩 fetch）、插件依赖兼容性、CLI 端到端。全部不联网、不读凭据。
