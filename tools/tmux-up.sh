#!/usr/bin/env bash
# Layout: orchestrator + 3 host shells + a logs window.
# Idempotent: re-running just attaches to the existing session.
set -euo pipefail

S=eeg

if tmux has-session -t "$S" 2>/dev/null; then
  exec tmux attach -t "$S"
fi

tmux new-session  -d -s "$S" -n main -x 220 -y 60
tmux split-window -t "$S:main"   -h
tmux split-window -t "$S:main.0" -v
tmux split-window -t "$S:main.2" -v

# main window: 0=orchestrator, 1=pc, 2=pi-a, 3=pi-b
tmux select-pane -t "$S:main.0" -T orchestrator
tmux select-pane -t "$S:main.1" -T pc          ; tmux send-keys -t "$S:main.1" 'ssh pc'   Enter
tmux select-pane -t "$S:main.2" -T pi-a        ; tmux send-keys -t "$S:main.2" 'ssh pi-a' Enter
tmux select-pane -t "$S:main.3" -T pi-b        ; tmux send-keys -t "$S:main.3" 'ssh pi-b' Enter

# logs window: always-on tails
tmux new-window  -t "$S" -n logs
tmux split-window -t "$S:logs"   -h
tmux split-window -t "$S:logs.0" -v
tmux split-window -t "$S:logs.2" -v
tmux send-keys -t "$S:logs.0" "ssh pc 'cd ~/git/eeg_roomba && docker compose logs -f --tail=20 ingest feature decision api'" Enter
tmux send-keys -t "$S:logs.1" "ssh pi-a 'journalctl -u pieeg -f -n 20'" Enter
tmux send-keys -t "$S:logs.2" "ssh pi-b 'journalctl -u roomba-state -f -n 20'" Enter
tmux send-keys -t "$S:logs.3" "ssh pc 'docker exec eeg_roomba-mosquitto-1 mosquitto_sub -h localhost -t \"#\" -v'" Enter

tmux set -g pane-border-status top
tmux select-window -t "$S:main"
tmux select-pane   -t "$S:main.0"

if [[ -t 0 && -t 1 ]]; then
  exec tmux attach -t "$S"
fi
