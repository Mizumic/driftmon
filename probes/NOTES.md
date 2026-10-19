# 探针组说明（冻结规则与来源）

这里放的是**数据**，不是逻辑。`probe-set.json` 一旦冻结，任何改动都必须换
`probeSetVersion`，旧基线与新基线并存（见 `docs/DATA-MODEL.md`）。

## 哈希规则

`probeSetHash = sha256(规范化(probe-set.json))`：

* 只保留 `probeSetVersion` + `probes`，**去掉其它顶层元数据**（`description` / `createdAt` / `source`）；
* 对象键递归排序，**数组顺序保持不变**（探针顺序参与 T 向量定义）；
* 探针里的说明性字段（`description` / `note`）不参与哈希，其余字段全部参与。

`probes/cache-prefix.txt` 是 C 组的长前缀，用 `promptSha256` 锁定字节；加载时校验，改过就拒绝运行。

## 各组的来源与已知缺口

| 组 | 内容 | 来源 | 置信度 |
| --- | --- | --- | --- |
| T | 5 条固定文本：纯 ASCII / 中文 / 生僻片段 / 特殊 token 字面 / 空白与 Unicode | `data/raw/2026-10-17-transcripts/tokenizer-race.txt` 的探针注释逐字节复原（不可见字符用转义写在 JSON 里） | 高（文本本身）；**特殊 token 字面那 3 个具体 token 转录没记清，用官方格式的 3 个特殊 token 复原，Phase 0 前需核对** |
| L | `Repeat exactly, no explanation: The capital of France is`，12 样本，max_tokens=6，logprobs+top5 | `logprob-race.txt` | 高 |
| G | 14 个 glitch token 的原样复述 | `glitch-battery.txt` 的「失败向量对比」表首列 | **中**：转录是终端渲染结果，部分 token 原始字节含不可见 Unicode 片段，转录时可能丢失；见 `glitch-tokens.json` 的 `status` |
| C | 固定长前缀 + 固定后缀，发两次，读第二次的 `cached_tokens` | `PREREQUISITES.md §4`；前缀由仓库内 `cache-prefix.txt` 冻结 | 高（实测网关侧一次请求 1584 prompt token，第二次 cached 1408） |
| S | 3 次最小请求，测 TTFT | `PREREQUISITES.md §4` | 高 |

## 2026-10-18 冒烟实测（只作对照，不作基线）

真实网关（`opencode-go / deepseek-v4.1-flash`）单会话冒烟：

* 两次采集分别落到 `luminal-dsv4.1flash` 与 `manhattan-project` → 印证「按会话绑定、到期重选」，也说明 K≥8 是必须的；
* T 向量实测 `[18, 17, 17, 39, 16]`（另一端点），与历史转录的 `44/43/43/36/64` 不同——**不同上游的计费口径确实不同**，跨端点不能混池；
* L 通道返回了 token 与 logprobs；G 通道有成功/失败位图；C 通道第二次请求 cached=1408；S 通道 TTFT 3.5–11s（慢端点）。
* 冒烟批次都带 `partial: true`，**不参与**基线与判定。

这些数字来自本地 `data/raw/*.jsonl`（不入库），想复核就重跑：

```bash
driftmon collect --sessions 1 --only T,L,G,S   # 冒烟用，partial 批次
```

## 空白与不可见字符

`probe-set.json` 里的字符串是**逐字节定义**：`\u200d`（零宽连接符）、`\u00a0`（不换行空格）、
`\u200b`（零宽空格）、`\u3000`（全角空格）、`\u2581`（下划线块）都在 JSON 里用转义写。
不要用编辑器"帮忙"重排这些字符——改一个字节就换哈希、旧基线作废。
