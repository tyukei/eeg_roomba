# eeg_roomba

3-node IoT pipeline: PiEEG → α power → Roomba. Background: `DESIGN.md`. Setup: `SETUP.md`.

## Hosts (ssh aliases)

| alias | role | repo path | unit |
|---|---|---|---|
| `gpu-2-chukei` | analysis / DB / UI (docker compose) | `~/git/eeg_roomba` | — |
| `pi-a` | PiEEG-16 acquisition | `~/Documents/eeg_roomba` | `pieeg.service` |
| `pi-b` | Roomba bridge | `~/Documents/eeg_roomba` | `roomba-state.service` |

## Conventions

- Idempotent remote ops only: `git pull` + `uv sync --frozen` + `systemctl restart`.
- Same op on multiple hosts → parallel `Agent` calls in one message.
- Long-running / interactive → tmux session `eeg`, pane `main.1`=gpu-2-chukei, `main.2`=pi-a, `main.3`=pi-b. Read with `tmux capture-pane -p -t eeg:main.<n> -S -200`.

## Stack rules (affect code generation)

- Python: **uv** only (`pyproject.toml` + `uv.lock`). Never `pip install`.
- DB: TimescaleDB. High-rate writes use `COPY` (asyncpg `copy_records_to_table`), never `INSERT`.
- MQTT: state topics are retained (`pieeg/health`, `control/state`, `control/threshold`, `roomba/state`); event topics are not (`eeg/chunk`, `eeg/live`, `eeg/alpha`, `roomba/cmd`).
- LSL flows pi-a outlet → PC ingest inlet (host networking + multicast). `ingest` uses `network_mode: host` for discovery. Don't add LSL between PC services or across analysis PCs — use MQTT for those.

## Skills (invoke by intent)

`health-check` · `tail-logs` · `deploy-all` · `bring-up-pi`
