#!/usr/bin/env bash
# Phase 0 噪声标定采集脚本（30 轮完整巡检，append-only，可断点续跑）
#
# 一轮巡检 = K=8 个新会话 × 冻结探针组（22 条探针 / 36 请求）≈ 37.7k token。
# 30 轮 ≈ 1.1–1.4M token（ROADMAP 估算 ≈ $0.36）、约 2 小时。
#
# 安全约束：
#   * key 只走环境变量 DEEPSEEK_API_KEY（或配置里 provider.apiKeyEnv 指名的变量），脚本不读/不写/不打印；
#   * 原始层 append-only：每轮由 driftmon collect 追加写 data/raw/YYYY-MM-DD.jsonl；
#   * 状态与日志写 .local/phase0/（gitignored），不污染仓库。
#
# 用法：
#   export DEEPSEEK_API_KEY=...                # 不要写进文件/仓库
#   ./scripts/phase0-calibrate.sh --dry-run    # 不花钱：打印计划并跑一次 collect --dry-run
#   ./scripts/phase0-calibrate.sh              # 正式采集 30 轮（可中断，重跑即续）
#   ./scripts/phase0-calibrate.sh --rounds 5 --interval 45
#   ./scripts/phase0-calibrate.sh --reset      # 清空本脚本的轮次状态（不删原始数据）
#
# 完成后：
#   node bin/driftmon.mjs baseline build --config <cfg>
#   node bin/driftmon.mjs baseline noise-floor --config <cfg> --rounds 30
#   （然后按 docs/PHASE0-PLAN.md 第 4 步做阈值 review）

set -euo pipefail

cd "$(dirname "$0")/.."

ROUNDS=30
CONFIG="config.official-deepseek.example.json"
INTERVAL=60
SESSIONS=8
DRY_RUN=0
RESET=0
STATE_DIR=".local/phase0"
LOG_DIR=".local/phase0"

while [ $# -gt 0 ]; do
  case "$1" in
    --rounds) ROUNDS="${2:?--rounds 需要参数}"; shift 2 ;;
    --rounds=*) ROUNDS="${1#*=}"; shift ;;
    --config) CONFIG="${2:?--config 需要参数}"; shift 2 ;;
    --config=*) CONFIG="${1#*=}"; shift ;;
    --interval) INTERVAL="${2:?--interval 需要参数}"; shift 2 ;;
    --interval=*) INTERVAL="${1#*=}"; shift ;;
    --sessions) SESSIONS="${2:?--sessions 需要参数}"; shift 2 ;;
    --sessions=*) SESSIONS="${1#*=}"; shift ;;
    --state-dir) STATE_DIR="${2:?--state-dir 需要参数}"; shift 2 ;;
    --state-dir=*) STATE_DIR="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --reset) RESET=1; shift ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数：$1（--help 查看用法）" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$ROUNDS" =~ ^[1-9][0-9]*$ ]]; then echo "--rounds 需要正整数，收到 $ROUNDS" >&2; exit 2; fi
if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]]; then echo "--interval 需要非负整数，收到 $INTERVAL" >&2; exit 2; fi

mkdir -p "$STATE_DIR" "$LOG_DIR"
STATE_FILE="$STATE_DIR/rounds.done"
LOG_FILE="$LOG_DIR/calibrate-$(date -u +%Y%m%dT%H%M%SZ).log"

if [ "$RESET" -eq 1 ]; then
  rm -f "$STATE_FILE"
  echo "已清空轮次状态（原始层数据不会删除）"
fi

if [ ! -f "$CONFIG" ] && [ ! -f "$CONFIG" ]; then
  echo "配置文件不存在：$CONFIG（从仓库根目录运行；官方端点的模板配置见 config.official-deepseek.example.json）" >&2
  exit 2
fi

# key 只从环境变量读：不打印、不落盘。
KEY_ENV="$(node -e '
const fs=require("fs");
try {
  const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  process.stdout.write(cfg.provider?.apiKeyEnv ?? "DEEPSEEK_API_KEY");
} catch { process.stdout.write("DEEPSEEK_API_KEY") }
' "$CONFIG")"
if [ -z "${!KEY_ENV:-}" ]; then
  echo "环境变量 $KEY_ENV 未设置：key 只走环境变量，不写进配置文件/仓库。" >&2
  echo "  export $KEY_ENV=...  然后重跑本脚本" >&2
  exit 2
fi

echo "Phase 0 标定计划"
echo "  配置：$CONFIG"
echo "  轮次：$ROUNDS 轮 × $SESSIONS 会话（每轮 22 条探针 / 36 请求）"
echo "  间隔：每轮之间 ${INTERVAL}s"
echo "  状态：$STATE_FILE（已完成轮次；重跑续跑）"
echo "  日志：$LOG_FILE"
echo "  预算：约 $((ROUNDS * 38))k token（dry-run 口径 37.7k/轮；ROADMAP 另估算 30 轮 ≈ 1.4M token ≈ \$0.36）"
echo

if [ "$DRY_RUN" -eq 1 ]; then
  echo "== dry-run：不花钱，仅验证配置与第一个请求 =="
  node bin/driftmon.mjs collect --config "$CONFIG" --sessions "$SESSIONS" --dry-run
  echo
  echo "dry-run 完成。确认无误后去掉 --dry-run 正式采集（会真的花钱）。"
  exit 0
fi

DONE=0
if [ -f "$STATE_FILE" ]; then DONE="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"; fi
if ! [[ "$DONE" =~ ^[0-9]+$ ]]; then DONE=0; fi
if [ "$DONE" -ge "$ROUNDS" ]; then
  echo "状态文件显示已完成 $DONE 轮（>= $ROUNDS），无需采集。如需重跑：--reset" >&2
  exit 0
fi
if [ "$DONE" -gt 0 ]; then echo "检测到已完成 $DONE 轮，从第 $((DONE + 1)) 轮继续（append-only 不改历史）"; fi

{
  echo "# phase0 calibrate start $(date -u +%FT%TZ)"
  echo "# config=$CONFIG rounds=$ROUNDS sessions=$SESSIONS interval=${INTERVAL}s"
} >> "$LOG_FILE"

for ((index = DONE + 1; index <= ROUNDS; index += 1)); do
  echo "[$(date -u +%FT%TZ)] 第 $index/$ROUNDS 轮开始"
  if ! node bin/driftmon.mjs collect --config "$CONFIG" --sessions "$SESSIONS" >> "$LOG_FILE" 2>&1; then
    echo "[$(date -u +%FT%TZ)] 第 $index 轮失败；已落盘的批次保留（append-only）。修复后重跑本脚本即可从 $index 轮续跑。" >&2
    echo "  日志：$LOG_FILE" >&2
    exit 1
  fi
  echo "$index" > "$STATE_FILE"
  echo "[$(date -u +%FT%TZ)] 第 $index/$ROUNDS 轮完成"
  if [ "$index" -lt "$ROUNDS" ] && [ "$INTERVAL" -gt 0 ]; then sleep "$INTERVAL"; fi
done

echo "[$(date -u +%FT%TZ)] 全部 $ROUNDS 轮完成。下一步："
echo "  node bin/driftmon.mjs baseline build --config $CONFIG"
echo "  node bin/driftmon.mjs baseline noise-floor --config $CONFIG --rounds $ROUNDS"
echo "  然后按 docs/PHASE0-PLAN.md 第 4 步做阈值 review"
