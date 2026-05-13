#!/usr/bin/env bash
# PostToolUse hook for Bash: append a one-line audit log for remote ops.
# Local-only file; useful for "what did Claude do on the Pis today?".
set -euo pipefail

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
STATUS="$(printf '%s' "$INPUT" | jq -r '.tool_response.status // .tool_response.exit_code // "?"')"

if [[ "$CMD" =~ ^ssh\ +(gpu-2-chukei|pi-a|pi-b) ]]; then
  LOG="${CLAUDE_PROJECT_DIR:-.}/.claude/remote-ops.log"
  mkdir -p "$(dirname "$LOG")"
  printf '%s  %s  %s\n' "$(date -u +%FT%TZ)" "$STATUS" "$CMD" >> "$LOG"
fi

exit 0
