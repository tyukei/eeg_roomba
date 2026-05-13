# eeg_roomba — operating notes for Claude

3-node IoT pipeline. PiEEG → α power → Roomba. Architecture rationale: `DESIGN.md`. Bring-up details: `SETUP.md`.

## Hosts (SSH config aliases)

| alias | role | repo path | service unit |
|---|---|---|---|
| `pc`   | analysis / DB / UI (docker compose host) | `~/git/eeg_roomba` | docker compose |
| `pi-a` | PiEEG-16 SPI acquisition | `~/Documents/eeg_roomba` | `pieeg.service` |
| `pi-b` | Roomba FastAPI + MQTT bridge | `~/Documents/eeg_roomba` | `roomba-state.service` (existing: `roomba-api.service`) |

Tailscale-flat network. SSH ControlMaster keeps connections warm — re-running `ssh pc 'cmd'` is cheap.

## Conventions

- Prefer **idempotent** remote commands. `git pull` + `uv sync --frozen` + `systemctl restart` instead of stateful steps.
- When you need to fan out the **same** operation to multiple hosts, launch parallel `Agent` calls (one per host) in a single message.
- For interactive/long-running work, push to the tmux session `eeg` (started by SessionStart hook). Each host has its own pane:
  - `tmux send-keys -t eeg:main.1 '<cmd>' Enter` — PC
  - `tmux send-keys -t eeg:main.2 '<cmd>' Enter` — Pi-A
  - `tmux send-keys -t eeg:main.3 '<cmd>' Enter` — Pi-B
  - Read output: `tmux capture-pane -p -t eeg:main.<n> -S -200`
- Destructive remote ops (`sudo rm`, `rm -rf`, `mkfs`, `dd if=`) and force-push to `main` are blocked by hook — don't fight it, run them manually after user confirmation.

## Common procedures

These live as on-demand skills; invoke by name or by intent:

- `health-check` — 3-node status snapshot ("状態は?" / "health")
- `tail-logs`   — recent logs across the stack
- `deploy-all`  — git pull + restart on all 3 nodes
- `bring-up-pi` — interactive provisioning of a fresh Pi

## Layered automation (decide before adding new behavior)

| When | Use |
|---|---|
| Just want to skip an approval prompt | `.claude/settings.local.json` → `permissions.allow` |
| Must enforce / block / observe regardless of model intent | hook in `.claude/settings.json` |
| Always-on convention / vocabulary / host map | this file (CLAUDE.md) |
| Reusable procedure invoked on demand | `.claude/skills/<name>.md` |
| Dynamic typed API to a long-lived state | MCP server (last resort) |

## Tool / repo specifics

- Python via **uv** (`pyproject.toml` + `uv.lock`). Never `pip install` directly. Update deps with `uv add` / `uv lock`.
- Frontend: Vite + React + uPlot.
- DB: TimescaleDB hypertables. Don't write raw `INSERT` for high-rate paths — use `COPY` (asyncpg `copy_records_to_table`).
- MQTT: retained topics carry **state** (`pieeg/health`, `control/state`, `control/threshold`, `roomba/state`). Non-retained carry **events** (`eeg/chunk`, `eeg/live`, `eeg/alpha`, `roomba/cmd`).
- LSL is **PC-internal** to ingest only. Don't try to forward LSL to remote networks.
