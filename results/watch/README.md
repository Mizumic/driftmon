# results/watch/ · 行为告警（模板对比）

`gray-watch.json` 由 `driftmon template check` 生成（可被外部展示层读取）：

- 它是一份**通用告警文件**（schema v1），不绑定任何具体宿主或插件；
- 展示层（例如 dsh-system-fingerprint 的徽标）可选读它（配置项 `externalAlertFile`），
  缺失/损坏时静默降级；
- 判定口径见 `docs/DATA-MODEL.md` 与 `src/gray.mjs`。

文件不入库（`results/watch/*.json` 已 gitignore），本说明保留。
