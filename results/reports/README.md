# results/reports/ · 判定报告（人可读）

一次判定一份 Markdown，统一命名：`YYYY-MM-DDTHHMM-<model>-<verdict>.md`
（UTC 时间；`verdict` 取五个固定值之一）。`docs/ROADMAP.md` 里提到的 `channel-*.md` / `timeline-*.md`
是**同一批文件按内容分组时的简称**，不是另一套命名——两处指同一批产物。

## 每份报告必须包含

1. **结论**：`insufficient` / `stable` / `route-change` / `drift-candidate` / `drift-confirmed`
   （取值固定，不允许"其他"）。
2. **证据表**：每个通道的观测值 vs 基线值 vs 是否超阈值。
3. **归因边界**：本次是"路由漂移"还是"模型漂移"，以及为什么这么判。
4. **没测到什么**：阴性结果与缺失的通道同样要写——"这条通道信号不足"是一个结论。
5. **可回溯信息**：`baselineVersion` + `probeSetHash` + 时间窗 + 阈值 + 样本量。

## 语气要求

* 说"观测到分布变化"，不说"模型被换了"；
* 说"在 x 样本量下差异超出噪声 p95"，不说"确定变了"；
* **不确定就写不确定**——这份报告的价值在于可信，不在于结论漂亮。
