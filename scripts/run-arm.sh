#!/usr/bin/env bash
#
# Run one reasoning-effort arm of the experiment and snapshot its debug output.
#
#   scripts/run-arm.sh <effort> [extra args passed to the pipeline...]
#
# Each arm runs the full pipeline at a single global reasoning effort, writes
# debug files, and copies them to eval/arms/<effort>/ for the referee to grade.
#
# The corpus must stay frozen across arms, so .cache/telegram_messages.json is
# never touched. GPT cache keys already include the model and effort, so arms
# coexist in the cache: re-running an arm costs nothing, and switching arms does
# not clobber a previous one.
#
# Events are printed rather than sent, so a sweep never spams the Telegram
# recipient configured in config.yaml.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: scripts/run-arm.sh <none|low|medium|high|xhigh> [extra pipeline args...]" >&2
  exit 1
fi

EFFORT="$1"
shift

case "$EFFORT" in
  none | low | medium | high | xhigh) ;;
  *)
    echo "error: unknown effort '$EFFORT' (expected none, low, medium, high or xhigh)" >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARM_DIR="$ROOT/eval/arms/$EFFORT"

cd "$ROOT"
mkdir -p "$ARM_DIR"

echo "=== arm: reasoning effort '$EFFORT' ==="
START=$(date +%s)

npx ts-node src/index.ts \
  --reasoning-effort "$EFFORT" \
  --write-debug-files true \
  --verbose-logging true \
  --send-events-recipient "" \
  "$@" 2>&1 | tee "$ARM_DIR/run.log"

ELAPSED=$(( $(date +%s) - START ))

cp debug/*.json "$ARM_DIR/"
echo "$ELAPSED" > "$ARM_DIR/elapsed_seconds"

echo "=== arm '$EFFORT' finished in ${ELAPSED}s -> $ARM_DIR ==="
