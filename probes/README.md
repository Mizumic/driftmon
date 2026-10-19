# probes/ · 配置层

**这里放"探针组"的定义——是数据，不是代码。**

> **术语**：一组固定探针叫「**探针组**」（英文仍写作 *probe set*，字段名 `probeSetHash` /
> `probeSetVersion`）。这个词借自测试学里的 *test battery*（测试组套，如神经心理测试组套、韦氏量表）——
> 一套**固定、逐次同构、合起来评分**的子测试。借它的原因正是本项目的两条硬要求：
> ① **必须冻结**（改一项，历史基线就不可比）；② **单项可以很弱，合起来才有判断力**
> （glitch 失败率噪声大、延迟信号弱，但和 token 计数叠加后可用）。
> 中文里"电池"容易被读成 electric battery，所以本库统一用「探针组」。

## 为什么探针组必须是冻结的

签名只有在**逐字节可比的探针组**之间才有意义。组一改，历史基线全部作废。
所以每次采集必须把 `probeSetHash`（探针组定义的 sha256）写进原始数据，比较前先校验它相等。

**不要**在这里放可变逻辑、不要"顺手优化一下探针"、不要按日期生成不同版本。
要改组 = 开新的 `probeSetVersion`，并把旧基线与新基线**并存**（不要覆盖）。

## 硬要求：输出必须落盘

2026-10-17 的教训：三个原型探针（tokenizer / logprob / glitch）**只 `print`、从不写文件**，
结果三条关键证据一度只存在于会话日志里，文档数字全靠手抄。因此：

* 任何采集脚本**必须把原始输出写成文件**到 `data/raw/`（append-only），**不允许只 print**；
* 一次性内联脚本**不算**证据来源——产生文档数字的探测必须先落成脚本文件再跑；
* 转录件（如 `data/raw/2026-10-17-transcripts/`）只能作为对照，地位低于机器产物。

## 计划中的文件（本窗口不创建）

| 文件 | 内容 |
| --- | --- |
| `probe-set.json` | T/L/G/C/S 五组探针的冻结定义（字符串、prompt、采样数、max_tokens 等） |
| `glitch-tokens.json` | G 组用的 glitch token 清单（含来源与首次记录） |
| `CHANGELOG.md` | 探针组的版本变更记录：每次改动的动机、影响哪些通道、旧基线是否作废 |

## 约束

* 探针里**不许**包含任何真实业务内容、代码片段或个人数据；
* 每条的 `max_tokens` 必须尽量小（现阶段 1–24），这是本项目低成本的前提；
* G 组的判定标准（"是否原样复述"）必须写成可复算的规则（归一化后比较），不要靠人工看。

## 探针组必须写清的字段（缺一项就没法比）

`probe-set.json` 里每条探针至少要有：

| 字段 | 说明 |
| --- | --- |
| `probeId` | 稳定 id，改文本就必须换 id（否则历史签名对不上） |
| `group` | `T` / `L` / `G` / `C` / `S` |
| `prompt` | 逐字节固定的内容（含空白与不可见字符，必须原样存） |
| `maxTokens` | 尽量小（T 组 1；G 组 24；L 组 6） |
| `samples` | 该探针在一次探针组里发几次（L 组默认 12；C 组固定 2 = 预热 + 读命中） |
| `prefixTokens` | **仅 C 组**：长前缀的目标长度，默认 **2000**（与 `PREREQUISITES.md §4` 的成本口径一致） |
| `readFrom` | **仅 C 组**：读第几次的 `cached_tokens`（固定 `"second"`） |
| `params` | `temperature` / `logprobs` / `top_logprobs` / `stream` 等显式写全 |

`probeSetHash` 的计算规则：**对 `probe-set.json` 做规范化后取 sha256**——
排序键、去掉 `probeSetVersion` 之外的元数据、保留全部探针字段**与它们的顺序**。
规则本身也必须写进文档，否则两个人算出两个哈希。

## 采样机制：怎么"开一个新会话"

网关侧认得的是**请求头 `x-opencode-session`**（缺了直接 400）。所以：

* "开一个新会话" = **换一个没用过的 `x-opencode-session` 值**（建议 `drift-<UTC时间戳>-<序号>`）；
* 别指望用同一个 id 连打就能拿到不同后端——路由**按会话绑定**，同一 id 会一直落在同一个端点上；
* 每条样本必须记下它用的那个 session 值，否则无法回查。

## 从响应头到字段的映射（采 provenance 时照这个抄）

| 采到的字段 | 取自响应头 |
| --- | --- |
| `endpointId` | `x-opencode-endpoint-id` |
| `upstreamModelId` | `x-opencode-upstream-model-id` |
| `gatewayModel` | `x-zen-model` |
| `colo` | `cf-placement` |
| `rayId` | `cf-ray` |
| `traceId` | `x-opencode-log-id`（官方端点则是 `x-ds-trace-id`） |
| `responseIdFamily` | 不在头里，从响应体的 `id` 归类：`hex-native`（≥32 位 hex）/ `gateway`（`gw-*`）/ `chatcmpl` / `uuid` / `other` |

（这套映射与 `plugins/dsh-system-fingerprint` 的实现一致；命名差异：那边叫 `placement`，本项目叫 `colo`。）
