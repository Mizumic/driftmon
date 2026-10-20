#!/usr/bin/env python3
"""生成 / 复核「官方 tokenizer 参考工件」data/reference/official-tokenizer-v41.json。

用途：把冻结探针组里 T 组探针的**期望 prompt_tokens** 用官方参考实现离线算出来，
给 driftmon 的 T 通道提供**绝对参照**（不只是跟自己的历史基线比）。
参考实现 = deepseek-ai/deepseek-recipe 的 Python 绑定（官方部署 Q&A 称其请求→prompt→token ID
的处理逻辑与 DeepSeek 官方 API「完整对齐」）；tokenizer 用该仓库自带的
`static/tokenizers/v41/tokenizer.json`（MIT，SHA-256 记录在工件里）。

这是一个**开发者工具**：生成一次、评审后入库；driftmon 运行时仍然纯 Node、零依赖，
只读工件，不依赖 Python / Rust / tokenizers。

依赖安装（不进入仓库，也不进入运行时）：

    python3 -m pip install --target .local/ref-py deepseek-recipe==0.2.0
    # 本机 PyPI 直连不通时用镜像：
    #   --index-url https://mirrors.aliyun.com/pypi/simple/

tokenizer.json 获取（与工件里的 sha256 必须一致）：

    curl -L -o .local/tokenizer-v41.json \\
      https://raw.githubusercontent.com/deepseek-ai/deepseek-recipe/935817c66f5d6e64838f419692545f06787e485f/static/tokenizers/v41/tokenizer.json
    sha256sum .local/tokenizer-v41.json    # 期望 81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99

生成 / 复核：

    PYTHONPATH=.local/ref-py python3 scripts/build-tokenizer-reference.py \\
        --tokenizer .local/tokenizer-v41.json            # 生成（已有内容变化时拒绝覆盖）
    PYTHONPATH=.local/ref-py python3 scripts/build-tokenizer-reference.py \\
        --tokenizer .local/tokenizer-v41.json --check    # 只复核，不写文件

刷新纪律：上游换 tokenizer / prompt 模板时，**不会**自动更新工件。默认模式发现向量或
tokenizer 变化会写 `<out>.candidate.json` 并退出 2，必须人工 review 后加 --force 替换；
换参照意味着历史 T 向量不再可比，按 docs/TOKENIZER-REFERENCE.md 的流程处理。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROBE_SET = REPO_ROOT / "probes" / "probe-set.json"
DEFAULT_OUT = REPO_ROOT / "data" / "reference" / "official-tokenizer-v41.json"

REFERENCE_VERSION = 1
REFERENCE_KIND = "official-tokenizer-reference"

EXPECTED_RECIPE_VERSION = "0.2.0"
EXPECTED_TOKENIZER_SHA256 = "81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99"
EXPECTED_TOKENIZER_GIT_BLOB = "3abdf13e3488acc65e11e6a57f073f6673175c3a"
EXPECTED_TOKENIZER_SIZE = 6367247
SOURCE_REPO = "https://github.com/deepseek-ai/deepseek-recipe"
SOURCE_COMMIT = "935817c66f5d6e64838f419692545f06787e485f"
MODEL_ALIAS = "deepseek-flash"
MODEL_VERSION = "DeepSeek-V4.1-Flash"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_reference(*, tokenizer_path: Path, probe_set_path: Path, model: str) -> tuple[dict, list[str]]:
    try:
        import deepseek_recipe as recipe
    except ImportError as error:  # pragma: no cover - 依赖缺失时给出可操作提示
        raise SystemExit(
            "缺少 deepseek_recipe（官方参考实现）。安装：\n"
            "  python3 -m pip install --target .local/ref-py deepseek-recipe==0.2.0\n"
            "然后：PYTHONPATH=.local/ref-py python3 scripts/build-tokenizer-reference.py ..."
        ) from error

    package_version = getattr(recipe, "__version__", "unknown")
    warnings: list[str] = []
    if package_version != EXPECTED_RECIPE_VERSION:
        warnings.append(
            f"deepseek-recipe 版本 {package_version} ≠ 工件记录的 {EXPECTED_RECIPE_VERSION}；"
            "若确认要跟随上游升级，需人工 review 后重建"
        )
    actual_sha256 = sha256_of(tokenizer_path)
    if actual_sha256 != EXPECTED_TOKENIZER_SHA256:
        warnings.append(
            f"tokenizer SHA-256 {actual_sha256} ≠ 工件记录的 {EXPECTED_TOKENIZER_SHA256}；"
            "tokenizer 已变，必须按 docs/TOKENIZER-REFERENCE.md review 后重建"
        )

    probe_set = json.loads(probe_set_path.read_text(encoding="utf-8"))
    probes = [probe for probe in probe_set["probes"] if probe.get("group") == "T"]
    if not probes:
        raise SystemExit(f"探针组里没有 T 组探针：{probe_set_path}")

    tokenizer = recipe.Tokenizer.from_file(str(tokenizer_path))
    encoding = recipe.DeepseekV41Encoding().with_tokenizer(tokenizer)
    options = recipe.ConversionOptions().with_model_alias(model, recipe.ModelVersion.DeepseekV41Flash)

    rows = []
    for probe in probes:
        # 请求形状必须与 driftmon src/collect.mjs buildRequest() 一致，否则算出来的不是同一件事。
        body = {
            "model": model,
            "messages": [{"role": "user", "content": probe["prompt"]}],
            "max_tokens": probe["maxTokens"],
            **probe.get("params", {}),
        }
        request = recipe.ChatCompletionRequest(body)
        conversation = request.convert(options).conversation
        prompt_ids = encoding.encode(conversation)
        rendered = encoding.render_conversation(conversation).prompt
        # fullVocabularyTokens：按完整词表（把 special token 字面当特殊 token）编码的长度。
        # 与 promptTokens 的差值说明「用户文本里的 special token 字面按普通文本编码」——
        # 这是官方防注入语义，也是 t-special 探针要测的东西（39 vs 29）。
        rows.append(
            {
                "probeId": probe["probeId"],
                "promptTokens": len(prompt_ids),
                "fullVocabularyTokens": len(tokenizer.encode(rendered)),
            }
        )

    vector = [row["promptTokens"] for row in rows]
    reference = {
        "version": REFERENCE_VERSION,
        "kind": REFERENCE_KIND,
        "generatedAt": int(time.time() * 1000),
        "note": (
            "T 通道的官方参考值：由 deepseek-recipe 的 V4.1 prompt 渲染 + 自带 v41 tokenizer 离线算出，"
            "对应请求形状与 driftmon 冻结探针组一致。仅用于 T 通道「身份/配置」核验，不参与 L/G/C/S 判定。"
        ),
        "referenceImplementation": {
            "package": "deepseek-recipe",
            "version": package_version,
            "pythonImport": "deepseek_recipe",
            "sourceRepo": SOURCE_REPO,
            "sourceCommit": SOURCE_COMMIT,
            "modelVersion": MODEL_VERSION,
            "encoding": "DeepseekV41Encoding",
            "modelAliases": [model, MODEL_VERSION],
            "alignmentClaim": (
                "官方部署 Q&A（DeepInfer/doc/DeepSeek V4.1 Flash 推理部署 Q&A.pdf）称 "
                "deepseek-recipe 的处理逻辑与 DeepSeek 官方 API 完整对齐"
            ),
        },
        "tokenizer": {
            "path": "static/tokenizers/v41/tokenizer.json",
            "sha256": "sha256:" + actual_sha256,
            "gitBlobSha": EXPECTED_TOKENIZER_GIT_BLOB,
            "sizeBytes": EXPECTED_TOKENIZER_SIZE,
            "license": "MIT",
            "upstreamModel": "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
            "upstreamComparisonRevision": "6821d6ad3681a4b137b066b76094fa82ebd0a380",
        },
        "probeSet": {
            "version": probe_set["probeSetVersion"],
            "hash": "sha256:" + hashlib.sha256(
                json.dumps(
                    {
                        "probeSetVersion": probe_set["probeSetVersion"],
                        "probes": [
                            {key: value for key, value in probe.items() if key not in ("description", "note")}
                            for probe in probe_set["probes"]
                        ],
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest(),
        },
        "requestTemplate": {
            "model": model,
            "messages": [{"role": "user", "content": "<probe.prompt>"}],
            "max_tokens": "<probe.maxTokens>",
            "params": "probe.params（thinking.type=disabled、temperature=0、stream=false）",
        },
        "probes": rows,
        "vector": vector,
        "provenance": {
            "generatedBy": "scripts/build-tokenizer-reference.py",
            "python": platform.python_version(),
            "platform": f"{platform.system().lower()}-{platform.machine()}",
        },
    }
    return reference, warnings


def comparable(reference: dict) -> dict:
    """用于判断「参照是否变化」的稳定子集（generatedAt / provenance 不参与）。"""
    return {
        "version": reference.get("version"),
        "kind": reference.get("kind"),
        "referenceImplementation": {
            "version": (reference.get("referenceImplementation") or {}).get("version"),
            "sourceCommit": (reference.get("referenceImplementation") or {}).get("sourceCommit"),
        },
        "tokenizer": {"sha256": (reference.get("tokenizer") or {}).get("sha256")},
        "probeSet": reference.get("probeSet"),
        "vector": reference.get("vector"),
        "probes": reference.get("probes"),
    }


def summarize(reference: dict) -> str:
    package = reference["referenceImplementation"]["package"]
    version = reference["referenceImplementation"]["version"]
    sha = reference["tokenizer"]["sha256"]
    vector = reference["vector"]
    lines = [
        f"{package} {version} · tokenizer {sha[:19]}…",
        f"probeSet={reference['probeSet']['hash'][:24]}… · T 向量={vector}",
    ]
    for row in reference["probes"]:
        lines.append(
            f"  {row['probeId']}: prompt_tokens={row['promptTokens']} "
            f"(完整词表 {row['fullVocabularyTokens']})"
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tokenizer", required=True, type=Path, help="deepseek-recipe 的 static/tokenizers/v41/tokenizer.json")
    parser.add_argument("--probe-set", type=Path, default=DEFAULT_PROBE_SET, help=f"默认 {DEFAULT_PROBE_SET}")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"默认 {DEFAULT_OUT}")
    parser.add_argument("--model", default=MODEL_ALIAS, help=f"请求里的 model 名（默认 {MODEL_ALIAS}）")
    parser.add_argument("--check", action="store_true", help="只复核现有工件，不写文件")
    parser.add_argument("--force", action="store_true", help="允许覆盖已存在的工件（人工 review 后使用）")
    args = parser.parse_args()

    if not args.tokenizer.is_file():
        raise SystemExit(f"tokenizer 文件不存在：{args.tokenizer}")
    reference, warnings = build_reference(
        tokenizer_path=args.tokenizer, probe_set_path=args.probe_set, model=args.model
    )

    for warning in warnings:
        print(f"⚠ {warning}", file=sys.stderr)

    existing = None
    if args.out.is_file():
        existing = json.loads(args.out.read_text(encoding="utf-8"))
    changed = existing is not None and comparable(existing) != comparable(reference)

    print(summarize(reference))
    if existing is None:
        print(f"现有工件：无（{args.out}）")
    elif changed:
        print("现有工件：与本次计算结果不同", file=sys.stderr)
        print(f"  旧 T 向量={(existing.get('vector'))}", file=sys.stderr)
        print(f"  旧 tokenizer={(existing.get('tokenizer', {}).get('sha256'))}", file=sys.stderr)
        print(f"  旧版本={(existing.get('referenceImplementation', {}).get('version'))}", file=sys.stderr)
    else:
        print("现有工件：一致")

    if args.check:
        return 1 if changed else 0

    text = json.dumps(reference, ensure_ascii=False, indent=2) + "\n"
    if changed and not args.force:
        candidate = args.out.with_name(args.out.stem + ".candidate.json")
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text(text, encoding="utf-8")
        print("")
        print(f"拒绝直接覆盖（参照变化需要人工 review）。候选已写入：{candidate}")
        print(f"review 通过后：mv {candidate.name} {args.out.name}，或加 --force 重跑")
        return 2

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8")
    print("")
    print(f"已写入：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
