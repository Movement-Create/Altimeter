#!/usr/bin/env bash
# Single-test runner. Captures only essential output to keep parent context clean.
# Usage: run-test.sh <test-id> <max-turns> "<prompt>" [extra-flags...]
# Writes: test-results/<test-id>.log  AND  prints a 1-line summary.

set -u
ID="$1"; shift
MAX="$1"; shift
PROMPT="$1"; shift
EXTRA="${*:-}"

LOG="test-results/${ID}.log"
START=$(date +%s)

# shellcheck disable=SC2086
node dist/index.js run \
  --model "google:gemini-2.5-flash" \
  --max-turns "$MAX" \
  --auto \
  $EXTRA \
  "$PROMPT" > "$LOG" 2>&1
RC=$?
END=$(date +%s)
ELAPSED=$((END-START))

# Extract: tool calls used, errors, final stop reason
TOOLS=$(grep -oE '^\[Tool\] [a-z_]+' "$LOG" | sort -u | sed 's/\[Tool\] //' | tr '\n' ',' | sed 's/,$//')
ERRS=$(grep -ciE 'error|fail|cannot|exceeded|max[_-]turns' "$LOG" || true)
SUMMARY=$(tail -5 "$LOG" | tr '\n' ' ' | head -c 200)

printf '%-32s rc=%d  %ds  tools=[%s]  errs=%d\n' "$ID" "$RC" "$ELAPSED" "$TOOLS" "$ERRS"
