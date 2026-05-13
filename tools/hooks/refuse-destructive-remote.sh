#!/usr/bin/env bash
# PreToolUse hook for Bash: block destructive patterns on remote SSH targets.
# Exit code 2 + stderr message tells Claude to stop and report.
set -euo pipefail

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"

if [[ -z "$CMD" ]]; then
  exit 0
fi

# Patterns to block. Tweak with team consensus.
PATTERNS=(
  'ssh +(pc|pi-a|pi-b)([^ ]| )* (sudo +)?rm +-rf'
  'ssh +(pc|pi-a|pi-b)([^ ]| )* mkfs'
  'ssh +(pc|pi-a|pi-b)([^ ]| )* dd +if='
  'ssh +(pc|pi-a|pi-b)([^ ]| )* > +/dev/sd'
  'git +push +(--force|-f) +origin +main'
)

for pat in "${PATTERNS[@]}"; do
  if [[ "$CMD" =~ $pat ]]; then
    echo "Refused by refuse-destructive-remote hook: pattern '$pat' matched. Run this manually after confirming with the user." >&2
    exit 2
  fi
done

exit 0
