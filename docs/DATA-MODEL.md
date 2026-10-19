# 数据模型（四层 + 已知检查点模板）

> 这份文档定义 driftmon 的数据层**各自存什么、不许存什么、谁可以改**。
> 四层是「观测 → 签名 → 基线 → 判定」主链；`data/templates/` 是挂在签名层上的**派生参考**（见「模板层」）。
> 硬约束只有一句：**原始观测不可再生，派生摘要可重算，判定结论必须可回溯。**

---

## 层 ①：原始层 `data/raw/`

**性质**：append-only。写入后不再修改、不再删除（过期靠滚动分卷，不靠改写）。

一行一个采样批次（JSON Lines，`data/raw/YYYY-MM-DD.jsonl`）：

```jsonc
{
  "batchId": "20261017T090231Z-8f21",       // 批次 id = **UTC** 时间戳 + 随机后缀（与 at 同时区）
  "probeSetHash": "sha256:9f3c…",            // 探针组定义的指纹：组一改，基线作废
  "at": 1792227751000,                       // 2026-10-17T09:02:31Z（与 batchId 同一时刻）
  "provider": "opencode-go",                 // 路由标识（provider id）
  "model": "deepseek-v4.1-flash",            // 请求的模型别名
  "api": "openai-completions",               // 协议
  "samples": [
    {
      "sampleId": "…-01",
      "session": "drift-20261017T090231Z-01",  // **新建**会话 id（保证样本独立）
      "at": 1792227751120,
      "status": 200,
      "provenance": {                          // ★ 必填：没有它就无法区分"路由漂移"
        "endpointId": "orcarouter-dsv4.1flash",
        "upstreamModelId": "deepseek/deepseek-v4.1-flash",
        "responseIdFamily": "hex-native",
        "traceId": "…",
        "colo": "remote-ORD"
      },
      "fingerprint": "e72d3c7f663d3e1383b00b3884cb4501",  // 官方端点响应里的 system_fingerprint；网关/流式为 null
      "channels": {
        "T": [ { "probeId": "t-ascii", "promptTokens": 44, "completionTokens": 1 },
               { "probeId": "t-special", "promptTokens": 64, "completionTokens": 1 } ],
        "L": { "tokens": ["We", " need"], "logprobs": [-0.0004, -1e-06],
               "topK": [["We"], [" need"]] },
        "G": { "bits": { "SetSavedPoint": false, "Nameeee": false, "Kahenera": true } },
        "C": { "prefixTokens": 2000, "secondCachedTokens": 1920 },   // 与 PREREQUISITES §4 的默认一致
        "S": [ { "ttftMs": 812, "totalMs": 1903 } ]
      }
    }
  ]
}
```

**不许存**：prompt 原文、响应正文、任何凭据字段。
（G 组的复述输出只存布尔位图与长度，不存文本；唯一许可的文本字段是 `probeId`。）

---

## 层 ②：签名层（派生，可重算）

**性质**：**纯函数产物**——给定一条原始样本 + 固定算法，必然得到同一个签名。
不单独落盘时也可以（重算即可）；落盘仅用于加速与便于 diff。

```jsonc
{
  "sampleId": "…-01",
  "endpointId": "orcarouter-dsv4.1flash",          // 从 provenance 提上来，便于分组
  "signature": {
    "T": { "vector": [44, 64], "hash": "sha256:…" },   // ← 逐字节相等才有意义
    "L": { "firstTokenTopK": ["We", " need"], "logprobMedian": -0.0004 },
    "G": { "failRate": 0.79, "rounds": 1 },
    "C": { "hitRatio": 0.98 },
    "S": { "ttftMedian": 812, "totalMedian": 1903 }
  }
}
```

**不变量**：签名必须**只依赖原始层**与**冻结的探针组定义**。签名里出现的任何"解释"都不算签名。

---

## 层 ③：基线层 `data/baselines/`

**性质**：滚动窗口聚合，按 `(端点, 通道)` 维护。**可以整体重建**，但重建必须记录原因。

```jsonc
{
  "baselineVersion": 3,
  "probeSetHash": "sha256:9f3c…",        // ★ 与原始层的探针组指纹一致，否则拒绝比较
  "stale": false,                       // 探针组换版后旧基线标 stale（不删除）
  "window": { "from": 1792000000000, "to": 1792231586000, "samples": 120 },
  "endpoints": {
    // ★ noiseFloor **必须挂在每个端点下面**（见不变量 2：不同端点不可混池）
    //    每个端点各自的：
    //      "L": { "topKJaccard": { "p50": …, "p95": …, "p99": …, "distinct": … } },
    //      "G": { "failRate": { "p50": …, "p95": … } },
    //      "S": { "ttftMs": { "p50": …, "p95": … } }
    "orcarouter-dsv4.1flash": {
      "samples": 84,
      "channels": {
        "T": { "vectorSeen": [[44, 64]], "distinctVectors": 1 },   // 唯一向量数 >1 即异常
        "L": { "logprobMedian": -0.0004, "iqr": 0.0012 },
        "G": { "failRate": 0.79, "ci95": [0.71, 0.86] },
        "C": { "hitRatioMedian": 0.98 },
        "S": { "ttftMedian": 812, "ttftP95": 1400 }
      }
    }
  }
}
```

**禁止**：把不同端点的样本混进同一个基线（会互相污染，且掩盖路由漂移）。

### Phase 0 噪声底 `data/baselines/noise-floor.json`

**性质**：`driftmon baseline noise-floor` 的派生产物（Phase 0 标定），只读原始层、可重建；
**不改阈值**——阈值替换是人工 review 步骤（见 [`PHASE0-PLAN.md`](PHASE0-PLAN.md)）。

```jsonc
{
  "formatVersion": 1,
  "kind": "noise-floor",
  "probeSetHash": "sha256:18c0…",
  "provider": "deepseek-official", "model": "deepseek-flash",
  "sessionsPerRound": 8,
  "window": { "rounds": 30, "batches": 240, "samples": 8640, "from": …, "to": …, "requestedRounds": 30 },
  "criteria": { "T": "…", "L": "…", "G": "…", "C": "…", "S": "…" },   // 每个通道的可用性判据（可解释）
  "endpoints": {
    "direct:deepseek-official": {
      "batches": 240, "samples": 8640, "rounds": 30, "from": …, "to": …,
      "channels": {
        "T": { "distinctVectors": 1, "vectorsObserved": [{ "vector": [18,17,17,39,16], "batches": 240 }], "modeShare": 1, "usable": true },
        "L": { "topKJaccard": { "p05": …, "p50": …, "p95": …, "p99": … }, "logprobMedian": 0, "probabilitiesDegenerate": true, "usable": true },
        "G": { "failures": …, "tokens": …, "failRate": …, "ci95": [ … ], "ci95Width": …, "usable": true },
        "C": { "hitRatio": { "p05": …, "p50": … }, "usable": true },
        "S": { "ttftMs": { "p50": …, "p95": … }, "p95OverP50": …, "usable": true }
      },
      "usableChannels": ["T","L","G","C","S"],
      "unusableChannels": {},           // 通道 → 不可用原因（噪声太大/信号缺失）
      "unavailableChannels": []         // 该端点根本没有这类数据
    }
  },
  "summary": { "judgementUsable": [...], "verdict": "calibrated|insufficient-window", "message": "…" },
  "skipped": { "partial": 0, "otherProviderModel": 0, "otherProbeSet": 0, "missingEndpoint": 0, "beforeSince": 0 },
  "caveats": ["…"]
}
```

**不变量**：与基线相同——先按 `endpointId` 分组、禁止跨端点混池；`unusableChannels` 必须写明原因
（允许结论是「这条通道不能用」）；`verdict` 为 `insufficient-window` 时不得用来调阈值。

---

## 派生参考：已知检查点模板层 `data/templates/`

**性质**：从原始层（+ 冻结探针组）重算出来的**已知检查点签名参考**，用来跨时间/跨端点比较。
不参与主链判定（`judge` 还不读它），但它是「灰度检测」和「无指纹网关反推检查点」的依据。
只接受 `probeSetHash` 一致、`partial=false`、且样本里出现指定 `system_fingerprint` 的完整批次。

```jsonc
{
  "version": 1,
  "kind": "known-checkpoint-template",
  "probeSet": { "version": "0.1.0-phase0", "hash": "sha256:18c0…" },  // ★ 换探针组即作废
  "checkpoint": { "name": "flash 1017", "fingerprint": "e72d3c7f…", "source": "system_fingerprint" },
  "provider": { "id": "deepseek-official", "baseURL": "https://api.deepseek.com", "model": "deepseek-flash" },
  "window": { "batches": 9, "sessions": 9, "samples": 324, "errors": 0, "from": …, "to": … },
  "availability": { "T": true, "L": true, "G": true, "C": true, "S": true },
  "channels": {
    "T": { "vector": [18, 17, 17, 39, 16], "hash": "sha256:0023…", "identicalAcrossBatches": true },
    "L": { "topKJaccardMedian": 0.7857, "logprobMedian": 0, "probabilitiesDegenerate": true },
    "G": { "failRateMedian": 0.2143, "identicalFailSets": true, "perToken": { "SetSavedPoint": { "successRate": 1 } } },
    "C": { "prefixTokens": 1584, "hitRatioMedian": 0.8889 },
    "S": { "ttftMedian": 115, "ttftRangeMs": [102, 125] }
  },
  "interpretation": {
    "fingerprintChannel": "system_fingerprint",
    "behaviorChannels": ["L", "G"],     // 权重敏感：灰度换权重时优先看
    "configChannels": ["T", "C"],       // tokenizer/缓存配置
    "infraChannels": ["S"]              // 服务栈/负载，不是模型信号
  }
}
```

**不变量**：T 向量必须批次间唯一（否则拒绝构建）；模板与 `probeSetHash` 绑定；可随时从 `data/raw` 重建。

---

## 层 ④：判定层 `results/`

### `results/alerts/`（机器可读）

```jsonc
{
  "alertId": "20261018T030000Z-77",
  "at": 1792263600000,                       // 2026-10-18T03:00:00Z（与 alertId 同一时刻）
  "subject": { "provider": "opencode-go", "model": "deepseek-v4.1-flash", "endpointId": "manhattan-project" },
  "verdict": "drift-candidate",
  "confidence": 0.72,
  "evidence": [
    { "channel": "T", "observed": [36], "baseline": [36], "verdict": "unchanged", "note": "同端点内一致" },
    { "channel": "G", "observed": 0.36, "baseline": 0.79, "verdict": "changed", "note": "同端点基线" }
  ],
  "occurrences": 2,                        // 同一结论重复出现时累加，不新建告警
  "baselineVersion": 3,
  "probeSetHash": "sha256:9f3c…",
  "window": { "from": 1792260000000, "to": 1792263600000 },
  "caveats": ["单批次结论，未复现", "L 通道未超阈值"]
}
```

### `results/watch/`（行为告警，机器可读）

`gray-watch.json`：`driftmon template check` 把最新窗口批次与已知检查点模板对比后的产物。
它是**通用告警文件**（schema v1），可被任何展示层读取（例如指纹插件配置 `externalAlertFile` 合并进徽标）：

```jsonc
{
  "version": 1,
  "kind": "behavior-watch",
  "level": "ok | info | warn",
  "verdict": "stable | insufficient | gray-candidate | checkpoint-change | config-change | infra-change",
  "updatedAt": 1792435200000,
  "message": "一句话结论",
  "subject": { "provider": "deepseek-official", "model": "deepseek-flash", "checkpoint": { "name": "flash 1017", "fingerprint": "e72d…" } },
  "template": { "file": "…", "probeSetHash": "sha256:…" },
  "window": { "batches": 8, "samples": 288, "from": …, "to": … },
  "signals": [ { "channel": "G", "verdict": "changed", "observed": 0.41, "expected": 0.21, "detail": "…" } ],
  "caveats": ["…"]
}
```

判定口径见 `src/gray.mjs` 顶部注释；阈值在 `config.gray.thresholds`（Phase 0 标定后替换）。
这一层是**展示/告警用**，不写回判定层 `results/alerts/`，也不改基线。

### `results/reports/`（人可读）

Markdown，一次判定一份，包含：结论、证据表、与上次的差异、下一步建议。
**必须写"这次没测到什么"**——缺失与阴性结果同样是结论。

---

## 四条不变量（写成代码前先记住）

1. **探针组冻结**：`probeSetHash` 不一致的两批数据**永远不可比较**。
2. **端点分组**：任何统计都必须先按 `endpointId` 分组；跨端点差异一律归入 `route-change`。
3. **不重复计数**：原始层与派生层不得同时被当成"观测数"累计（端点登记表踩过这个坑）。
4. **判定可回溯**：每条 alert / report 必须记录 `baselineVersion` + `probeSetHash` + 时间窗 + 阈值。
