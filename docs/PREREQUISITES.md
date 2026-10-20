# 前置知识（写实现之前必须读）

> 本文件**不是**零基础教程，而是 2026-10-17 那一轮实测中拿到的硬事实、可复现的测量值、
> 以及踩过的坑。每条都标了来源与置信度。**不看这份就写代码，大概率会把已知的坑重踩一遍。**

---

## 1. 通道清单：哪些能用、在哪些路由能用

同一条通道在不同协议/网关上的可用性不同——这是最容易踩的坑。

| 通道 | 官方端点（`api.deepseek.com/chat/completions`） | OpenCode Go 网关（`opencode.ai/zen/go/v1`） | 备注 |
| --- | --- | --- | --- |
| `system_fingerprint` | ✅ 有（32 位 hex） | ❌ **完全没有**（6 模型 × 流式/非流式 × 两条路径） | 官方的"承诺通道"；网关侧无 |
| `logprobs` | ❌ 返回 `null` | ✅ **支持**（`top_logprobs=5`） | **反向**：能力在网关侧 |
| `usage.prompt_tokens` | ✅ | ✅ | 两边都能用，本项目的主力通道 |
| glitch token 复述 | 未测 | ✅ 测过 | 需要目录与统计 |
| `cached_tokens` | ✅（另有 `prompt_cache_hit_tokens`） | ✅（只有 `prompt_tokens_details.cached_tokens`） | 字段名不同 |
| 响应头溯源 | `x-ds-trace-id` / `eo-log-uuid` | `x-opencode-endpoint-id` / `-log-id` / `-upstream-model-id` / `x-zen-model` / `cf-ray` / `cf-placement` | 字段名完全不同；注意插件的 `traceId` 在网关侧优先取 `x-opencode-log-id` |

**结论**：通道可用性必须**按路由探测后再启用**，不能假定"OpenAI 兼容都一样"。

---

## 2. 噪声现实（这三条决定阈值怎么定）

### 2.1 `temperature: 0` **不等于**可复现

实测（`.scratch/fp-gateway/logprob-race.py`，89 轮 / 约 40 分钟，同一 prompt、`temperature: 0`）：

* 生成的 token 序列**每轮都在变**（`We need answer exactly repeat no` / `…exactly no explanation` / `…exact repeat .` 等）；
* 同一个 token 序列还会配上**不同的 logprob 数值**：例如
  `[-4.6e-05, -4e-06, -2.7e-05, -0.245196, -0.473493, 0]` 与
  `[-0.000383, -1e-06, -1e-05, -0.185911, -1.218494, 0]` 对应同样的 token 串。

原因（推测）：MoE 专家路由 + 批处理非确定性。

**推论**：logprob 通道**只能做统计比较**（分布、排序、中位数、top-k 集合重合度），
**不能做逐次精确匹配**。任何"两次不一样就报警"的实现都是错的。

### 2.2 glitch token 的失败集合逐轮会变

实测（`.scratch/fp-gateway/glitch-battery.py`，14 个 token/轮）：manhattan-project 轮次间失败数 11 / 8 / 12 / 11；
两个端点的失败集合高度重叠但**不完全相同**，且差异落在**同一端点内部的波动范围内**。

**推论**：glitch 通道要**多轮取失败率**，不能拿单轮结果做判定。

### 2.3 端点会轮转 → 最大的假阳性来源

实测：同一模型别名背后有多个上游端点，路由**按会话绑定、到期重选**。证据：

* 同一负载、A/B 两个会话交替 20 对：18 对一致、**2 对同时落在不同端点**；
* 另一会话连跑 89 轮 / 40 分钟一次没换（会话粘性）；
* `glm-5.3-flash` / `omen-alpha` 在两轮扫描之间从 `relace-glm5.3flash` / `zai` 轮转到 `perplexity-glm5.3flash`。

**推论（关键设计约束）**：**换了端点 ≠ 模型漂移**。每条样本必须带上端点溯源信息，
判定时必须先把"路由漂移"和"模型漂移"分开，否则会把服务方切换误报成"模型悄悄变了"。

### 2.4 tokenizer 计数差分是最"硬"的信号

实测（`.scratch/fp-gateway/tokenizer-race.py`，同一脚本、同一探针组）：

* **各探针文本在同一个端点内逐次完全一致**：`纯ASCII = 44`、`中文 = 43`、`生僻片段 = 43`、
  `空白与Unicode = 42`（31 次采样同一个值）。
* **但含 3 个 DeepSeek 特殊 token 字面（`复述：` + 3 个 `<｜…｜>`）的那条不同**：
  `manhattan-project = 36` vs `orcarouter-dsv4.1flash = 64`（各自端点内 2 / 31 次采样稳定）。

**怎么解读**：同一段字节在两端点的**计费口径不同**（一边当单 token 或直接吃掉，另一边拆成十几段文本）。
**不要**把它和"普通文本"那组数值混着比——它们是不同字符串，不是同一基线的两个端点。
反过来，普通文本那几行**在端点间完全一致**，正是"两条链路共用同一分词器"的旁证。

**推论**：这是唯一在**单次测量**下就能给出确定差异的通道（纯计费口径，无采样噪声）。
但它**只对 tokenizer / 配置变化敏感，纯换权重看不出来**。

---

## 3. 采样设计：为什么必须多会话

因为路由按会话绑定（§2.3），**单个会话的连续采样会全部落在同一个后端上**。
要观察"这个别名现在有哪些后端"，必须：

1. 每次采样**开 K 个新会话**（K 建议 ≥ 8），每个会话发一次固定请求；
2. 记录每个样本的 `endpoint id`，按端点分组；
3. 判定"漂移"时**先在每个端点内部比**，跨端点差异单独归类为"路由漂移"。

反例（本窗口真实踩过）：想比两个端点的 tokenizer 口径，用单会话等了 40 分钟没等到翻转；
改成多开会话后，12 个会话一次就拿到两边样本。

---

## 4. 成本模型（实测值，不是估算）

**先把三个粒度定死，否则数字一定对不上**（本文件初版就栽在这里：把"一个会话"和"一轮巡检"混着算，差了 8 倍）。
**2026-10-20 Phase 0（官方 flash 1017，30 轮 / 240 批 / 8640 请求）已给出实测值**，
下表实测口径已替换原估算；费用仍按 off-peak 单价折算（未对账）：

| 粒度 | 定义（实测口径） |
| --- | --- |
| **一次探针组** | **一个会话**把整套探针发一遍（T+L+G+C+S）≈ **3.7k token** |
| **一轮巡检** | **K = 8 个新会话**各发一次探针组 ⇒ ≈ **29.7k token** |
| **基线标定（Phase 0）** | 30 轮巡检 ⇒ **892k token**（2h07m） |

| 项 | 实测/折算 |
| --- | --- |
| 一次探针组（单会话，**不含 C 组**） | ≈ **0.55k token**（T 112 + L 240 + G 195；S 流式无 usage、不计） |
| 一次探针组（**含 C 组**，前缀 1584 token × 2 次，第二次命中缓存） | ≈ **3.7k token**（其中 C ≈ 3.2k）← **默认口径** |
| 一轮巡检（K=8，含 C） | ≈ 29.7k token ≈ **$0.005**（off-peak 上界，缓存折扣后更低） |
| 每 6 小时一轮 ⇒ 月 | 120 轮 ⇒ 3.6M token ≈ **$0.58 / 月** |
| 每小时一轮 ⇒ 月 | 720 轮 ⇒ 21.4M token ≈ **$3.5 / 月** |
| Phase 0 基线标定（30 轮 × K=8，一次性） | **892k token**（prompt 869k + completion 23k，cached 676k）≈ **$0.14** |
| 原始层（每轮 8 批） | 约 210 KB / 轮（实测 26 KB / 批） |
| 基线文件 / 噪声底文件 | 约 1.7 KB / 5 KB / 次（聚合摘要，不随轮次线性增长） |

> **C 组是大头**（占 token 约 **85%**，实测 760,800 / 892k）：它要发一段长前缀两次。
> 想省钱就把它降频——例如只在"怀疑有切换"时才带 C，其余四组每月 ≈ **$0.08**。

**参照系**：本会话真实对话请求的 `usage` 实测为 **prompt 25–27 万 token、其中 cached 占 95%+**
（见 `home/storages/system-fingerprint/raw/*-chat-*.sse` 的 `prompt_tokens_details.cached_tokens`）。
即一次正常对话请求的量级是**几十万 token**，而一轮巡检才 3 万——
所以**探测成本不是问题，噪声与判定设计才是**。

> 注：以上按 V4.1 Flash off-peak（$0.15/M in、$0.60/M out）折算，且未计订阅制下"用量额度"的影响；
> 若走 Go 订阅的 $80/月额度，每小时一轮也只占 4.4%。

---

## 5. 数据分层与"不重复计数"

来自端点登记表的教训（本项目直接继承）：

* 第一版采集器把登记表当"每次重建"的产物 → 不带 `--sweep` 重跑一次，19 个端点掉回 2 个。
* 正确做法：`live`（权威计数，整体替换）/ `sweep`（append-only 日志）/ `history`（存在性兜底）分开存，
  汇总时只算一次。生成物可重建，标注永不丢。

**推论**：driftmon 必须区分「原始观测」与「派生摘要」与「判定结论」，且判定要能回溯
（用了哪段基线、什么阈值、什么时候下的结论）。

---

## 6. 语义诚实（从插件继承的原则）

本窗口一开始就在这一点上做了产品决策：网关拿不到指纹时，插件**不显示任何检查点名**——
`fingerprint.available = false` + 原文写"这不是模型指纹"，而不是回退到旧值冒充。

driftmon 同理：**"样本不足"是一个合法的判定结果**，不能因为"必须给个结论"就把噪声说成漂移。

---

## 7. 官方参考实现的旁证（2026-10-20，思路引用；不运行、不作依赖）

2026-10-16/20，DeepSeek 官方开源了推理框架 [`DeepInfer`](https://github.com/deepseek-ai/DeepInfer)
与 Token 编解码组件 [`deepseek-recipe`](https://github.com/deepseek-ai/deepseek-recipe)。
**本项目不运行 DeepInfer、不引入它的代码，也不把它的性能/部署假设带进来**；这里只记录
「它解释了我们观测到的哪些现象 / 提供了哪些可以用的参照」，避免把「我们不知道原因」写成设计。

依据：两个仓库的 README、`deepinfer/environ.py`、`tests/models/*`、
`deepseek-recipe` 的 tokenizer/encoding 源码，以及官方部署 Q&A
（[`doc/DeepSeek V4.1 Flash 推理部署 Q&A.pdf`](https://github.com/deepseek-ai/DeepInfer/blob/main/doc/DeepSeek%20V4.1%20Flash%20%E6%8E%A8%E7%90%86%E9%83%A8%E7%BD%B2%20Q%26A.pdf)）。
阅读版本：DeepInfer main `8b16149…`、deepseek-recipe `0.2.0`（main `935817c…`）。

| 官方信息（来源） | 对本项目的意义 | 落地位置 |
| --- | --- | --- |
| 默认 checkpoint 是 `deepseek-ai/DeepSeek-V4.1-Flash-1017`（`examples/_config.py`） | 「flash 1017」有了官方出处；模板名不再只是我们自己起的名字 | `data/templates/checkpoint-flash_1017.json`、E9 |
| 官方 Q&A 称 `deepseek-recipe` 的处理逻辑与 DeepSeek 官方 API「完整对齐」；它自带 V4.1 tokenizer 与 prompt 渲染 | T 通道可以做**绝对参照**：离线算期望 `prompt_tokens`，识别 tokenizer/模板/请求渲染路径变化 | [`docs/TOKENIZER-REFERENCE.md`](TOKENIZER-REFERENCE.md)、`reference check`、E11 |
| `DEEPINFER_BATCH_INVARIANT` 是可选开关（示例默认开、eval 默认不开、NPU 不支持）；官方测试要求 batch-invariant 下 token/logprob/top-k **逐位一致**，decode-step logprob 与 full prefill 的 KL 为 0 | 解释了为什么 `temperature: 0` 也不可复现（见 §2.1）；也给出一个**配置变化信号**：如果某天观测变成「逐次完全一致/噪声突然消失」，可能是对方开了 batch-invariant，而不是模型变稳 | §2.1；`docs/TOKENIZER-REFERENCE.md` §5 |
| 同一 checkpoint 的 golden PPL 在 NVIDIA 与 Ascend 平台**数值不同**（如 1.02908 vs 1.02973），但同平台内要求逐位相等 | 跨端点/跨硬件不能比 logprob 绝对值；L 通道只用 top-k 集合是正确的（§2.1、§2.4） | §2、`docs/DESIGN.md` §6 |
| `environ.py` 里的运行时开关会**不改权重就改变机械行为**：batch-invariant、`USE_NEXTN_DECODE`/MTP varlen、DFLASH confidence 温度、`SAMPLER_FORCE_TOPK`、`DECODE_TOKEN_BLACKLIST`（官方 eval 默认屏蔽 token 0/2/129262..129264）、YoCo prefill 截断、xgrammar 结构化输出、EPLB | 漂移归因清单：L/G 动而 T 不动时，先怀疑采样/解码/部署配置，而不是权重；C/S 更像缓存与基础设施 | `docs/DESIGN.md` §5；`template check` 的 `config-change`/`infra-change` 分类 |
| YoCo SWA Bounded Replay：长 prompt 只重算最后 128 token，前缀命中长度上限 L−134；V4.1 的 store 层数/窗口有固定参数 | 长上下文探针的差异可能是「官方本来就会截断重算」，不能当漂移；当前探针都很短（<30 token）不受影响 | §2；以后加长上下文通道前必须读 |
| KV cache 放在 3FS、TTL 3 天（agent）/7 天（chatbot），命中长度由 Block KVCache + SWA KVCache 决定 | C 通道测的是服务栈/缓存基础设施，不是模型权重；C 变化应是 `config-change` 候选 | `docs/DESIGN.md` §5、`template.mjs` 的 `configChannels` |
| V4 vs V4.1 的能力差异（图片、mid-conversation system message、deferred tool loading、`top_p` 归一化、`max_tokens` 默认 8192/65536/131072、上限 393216） | 兜底判别：若怀疑别名映射换了模型版本，可用这些行为探针区分；本项目只监测官方 `deepseek-flash`，不主动做版本归因 | `docs/DESIGN.md` §1「反问题」 |

**明确不做**：不 clone/运行 DeepInfer、不引入 Rust 构建、不用它当 ground truth 模板（本地也跑不了：
需要 SM100/Ascend 950、CUDA 13，开源版还缺 KV cache、P/D 分离与负载均衡）。
它在本项目里的角色只有两个：**解释现象**（为什么噪声长这样）和**提供离线参照**（T 通道的
官方 tokenizer/模板，见 `docs/TOKENIZER-REFERENCE.md`）。


