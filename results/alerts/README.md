# results/alerts/ · 判定结果（机器可读）

给自动化消费的告警，JSON，一条一个文件（结构见 `docs/DATA-MODEL.md` 层 ④）。

## 规则

* 只写**判定层**的结论；不在告警里放原始样本（需要时按 `batchId` 回查 `data/raw/`）。
* 每条告警必须能回答四个问题：
  1. 对谁下的结论（provider / model / endpointId）？
  2. 依据什么（`baselineVersion` + `probeSetHash` + 时间窗 + 阈值）？
  3. 哪些通道支持这个结论，哪些反对或没信号？
  4. 置信度多少，以及**为什么不是更高**（写进 `caveats`）。
* 同一结论重复出现时**追加 `occurrences` 与最新时间**，不要刷屏式新建告警。

## 预留的错误做法（别这么干）

* 单通道超阈值就发 `drift-confirmed`；
* 端点切换被当成模型漂移；
* 没写 `caveats` 就发高置信度告警；
* 把"统计显著"直接写成结论性判断。
