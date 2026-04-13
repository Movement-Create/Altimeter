#!/usr/bin/env bash
# Kimi/Moonshot test runner. Same as run-test.sh but routes via OpenAI-compatible
# provider with Moonshot base URL and a kimi model.
set -u
ID="$1"; shift
MAX="$1"; shift
PROMPT="$1"; shift
EXTRA="${*:-}"

LOG="test-results/${ID}.log"
START=$(date +%s)

# shellcheck disable=SC2086
node dist/index.js run \
  --model "openai:kimi-k2-0905-preview" \
  --max-turns "$MAX" \
  --auto \
  $EXTRA \
  "$PROMPT" > "$LOG" 2>&1
RC=$?
END=$(date +%s)
ELAPSED=$((END-START))

TOOLS=$(grep -oE '^\[Tool\] [a-z_]+' "$LOG" | sort -u | sed 's/\[Tool\] //' | tr '\n' ',' | sed 's/,$//')
ERRS=$(grep -ciE 'error|fail|cannot|exceeded' "$LOG" || true)

printf '%-32s rc=%d  %ds  tools=[%s]  errs=%d\n' "$ID" "$RC" "$ELAPSED" "$TOOLS" "$ERRS"
