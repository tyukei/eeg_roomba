#!/usr/bin/env bash
# SessionStart hook: ensure the eeg tmux session exists.
# Runs *outside* the model's context; harness reads stdout as additional context.
set -euo pipefail

PROJECT="${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR not set}"

if command -v tmux >/dev/null && ! tmux has-session -t eeg 2>/dev/null; then
  # Detached only — never attach inside a hook.
  ( "$PROJECT/tools/tmux-up.sh" </dev/null >/dev/null 2>&1 & ) || true
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"tmux session `eeg` started in background. Attach in another terminal with: tmux attach -t eeg"}}'
else
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"tmux session `eeg` already running. Attach with: tmux attach -t eeg"}}'
fi
