# data/templates/ · 已知检查点的行为向量模板

模板 = 某个**已知检查点**（由官方 `system_fingerprint` 认定）在**冻结探针组**下的一组签名参考。
它是派生层：从 append-only 的 `data/raw/` 重建，随时可重算；入库的只有模板 JSON。

用途：

1. **无指纹网关反推检查点**：网关不返回指纹时，用行为签名对模板（T 向量 / G 失败率 / L top-k …）；
2. **官方灰度检测**：官方 `system_fingerprint` 没变、但行为通道（L top-k / G）相对模板偏移或出现双峰 →
   疑似灰度/静默变更；`T/C/S` 用来区分「配置/服务栈变了」与「权重变了」。

| 文件 | 检查点 | 指纹（官方） | 生成方式 |
| --- | --- | --- | --- |
| `checkpoint-flash_1017.json` | flash 1017 | `e72d3c7f663d3e1383b00b3884cb4501` | 2026-10-20 · 官方端点 **5 轮完整巡检**（40 批 / 1440 样本 / 0 错误，指纹覆盖 1320） |

## 重建

```bash
export DEEPSEEK_API_KEY=...          # key 只走环境变量
# 1) 采一轮（K=8 新会话 × 冻结探针组；官方 flash 约 3 万 token/轮）
# 1) 采 5 轮（每轮 K=8 新会话；官方 flash 约 3 万 token/轮）
node bin/driftmon.mjs collect --config config.official-deepseek.example.json --sessions 8   # ×5
# 2) 固化模板（只读原始层，不联网；按指纹 + --since 圈定 5 轮窗口）
node bin/driftmon.mjs template build --config config.official-deepseek.example.json \
  --fingerprint e72d3c7f663d3e1383b00b3884cb4501 --name "flash 1017" \
  --since 1792434574115
# 3) 对模板做一次对比（默认窗口=最近一轮 K=8）→ results/watch/gray-watch.json
node bin/driftmon.mjs template check --config config.official-deepseek.example.json
```

本轮实测（5 轮）：T 向量 `[18,17,17,39,16]` 40/40 批一致；G 失败 3/14 且失败集合 40/40 批一致；
L top-k 中位 0.819（范围 0.786–1）；C 命中 0.889；S 中位 117ms（105–179）；`template check` 判 `stable`。

模板与 `probeSetHash` 绑定；探针组换版后旧模板会因 hash 不同被拒绝（需重采重建）。
字段定义见 [`docs/DATA-MODEL.md §模板层`](../../docs/DATA-MODEL.md)。
