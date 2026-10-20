# results/reference/ · T 通道核验结果（机器可读）

`tokenizer-check.json` 由 `driftmon reference check` 生成：把窗口内实测的 T 向量与
**官方 tokenizer 参考工件**（`data/reference/official-tokenizer-v41.json`，由官方
`deepseek-recipe` + 自带 v41 tokenizer 离线生成）比对。

## 口径

- `status=match`：T 向量与官方参考一致 → tokenizer / prompt 模板 / 请求渲染路径仍与官方参考实现一致；
  **不代表权重没变**（权重漂移看 `judge` / `template check`）。
- `status=mismatch`：tokenizer 换版、prompt 模板变化、请求渲染路径变化，或网关改写了 prompt
  （例如注入 system prompt）。`diffs` 里给出逐探针差异，需人工判断是哪一种。
- `status=insufficient`：窗口内没有可比的完整批次，不下结论（合法结果）。

## 规则

- 只写核验结论与比对窗口，不复制原始样本（需要时按 `window` 时间范围回查 `data/raw/`）。
- 参照工件本身**不是**这里生成的：它经过人工评审后入库，生成/复核方式见
  `scripts/build-tokenizer-reference.py` 与 `docs/TOKENIZER-REFERENCE.md`。

文件不入库（`results/reference/*.json` 已 gitignore），本说明保留。
