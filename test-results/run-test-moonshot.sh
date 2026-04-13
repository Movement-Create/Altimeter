#!/usr/bin/env bash
# Runner using the NEW first-class moonshot provider (MOONSHOT_API_KEY env).
set -u
ID="$1"; shift
MAX="$1"; shift
PROMPT="$1"; shift
EXTRA="${*:-}"

LOG="test-results/${ID}.log"
START=$(date +%s)

# shellcheck disable=SC2086
node dist/index.js run \
  --model "moonshot:kimi-k2-0905-preview" \
  --max-turns "$MAX" \
  --auto \
  $EXTRA \
  "$PROMPT" > "$LOG" 2>&1
RC=$?
END=$(date +%s)
ELAPSED=$((END-START))

TOOLS=$(grep -oE '^\[Tool\] [a-z_]+' "$LOG" | sort -u | sed 's/\[Tool\] //' | tr '\n' ',' | sed 's/,$//')
# Only count real error markers, not the model's summary text
ERRS=$(grep -cE '^(\[Error\]|Error:|\[Retry)' "$LOG" || true)

printf '%-32s rc=%d  %ds  tools=[%s]  errs=%d\n' "$ID" "$RC" "$ELAPSED" "$TOOLS" "$ERRS"
