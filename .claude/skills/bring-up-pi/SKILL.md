---
name: bring-up-pi
description: Interactive provisioning of a fresh Raspberry Pi (Pi-A=PiEEG acquirer or Pi-B=Roomba addon). Walks through SSH alias, apt, uv, gh auth, repo clone, .env, uv sync, systemd. Use when the user says "新しいPi立てる" "Pi-Aセットアップ" "bring-up".
---

# bring-up-pi

Designed to be **interactive**. Confirm each non-idempotent step with the user before running it on the remote.

## Phase 0 — gather inputs (AskUserQuestion)

- Which node? `pi-a` | `pi-b`
- SSH alias resolves? Verify with `ssh -o BatchMode=yes -o ConnectTimeout=3 <alias> true`
- `.env` values:
  - Pi-A: `MQTT_HOST` (PC Tailscale IP), `MQTT_PORT=1883`, `LSL_STREAM_NAME=PiEEG-16`
  - Pi-B: `MQTT_HOST`, `MQTT_PORT=1883`, `ROOMBA_HTTP_BASE=http://localhost:8000`

## Phase 1 — OS prep (Pi-A only enables SPI)

```bash
ssh <alias> 'sudo apt update && sudo apt install -y git libgpiod2 build-essential pkg-config gh'
# Pi-A only:
ssh pi-a 'sudo raspi-config nonint do_spi 0 && sudo usermod -aG spi,gpio,dialout $USER'
```
Pi-A: ask the user to reboot before continuing (`sudo reboot`), wait for re-SSH.

## Phase 2 — uv install (user-level)

```bash
ssh <alias> 'curl -LsSf https://astral.sh/uv/install.sh | sh'
```

## Phase 3 — gh auth + clone

Run `ssh -t <alias> 'gh auth login'` interactively; user completes the device-code flow in their local browser.
Then:
```bash
ssh <alias> 'mkdir -p ~/Documents && cd ~/Documents && gh repo clone tyukei/eeg_roomba'
```

## Phase 4 — write `.env`

Using `cat > ... <<EOF` over SSH with the values gathered in Phase 0.

## Phase 5 — liblsl (Pi-A only)

If pylsl import fails with "LSL binary library file was not found":
```bash
ssh pi-a 'sudo apt install -y cmake && cd /tmp && git clone --depth 1 https://github.com/sccn/liblsl.git && \
  cmake -S /tmp/liblsl -B /tmp/liblsl/build -DCMAKE_BUILD_TYPE=Release && \
  cmake --build /tmp/liblsl/build -j$(nproc) && sudo cmake --install /tmp/liblsl/build && sudo ldconfig'
```

## Phase 6 — uv sync + dry run

```bash
ssh <alias> 'cd ~/Documents/eeg_roomba/<node_dir> && ~/.local/bin/uv sync && ~/.local/bin/uv run --frozen python <entry>'
```
- Pi-A: `<node_dir>=pi_a_acquirer`, `<entry>=acquirer.py`. Expected: `PiEEG-16 acquisition started: 16ch @ 250 Hz`
- Pi-B: `<node_dir>=pi_b_roomba_addon`, `<entry>=mqtt_state_publisher.py`. Expected: 1 Hz HTTP GET 200.

Have the user Ctrl-C after a few seconds.

## Phase 7 — systemd

```bash
ssh <alias> 'sudo cp ~/Documents/eeg_roomba/<node_dir>/<unit>.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now <unit>'
```
- Pi-A: `<unit>=pieeg`
- Pi-B: `<unit>=roomba-state`

Verify with `systemctl is-active <unit>` and 10 lines of `journalctl`.

## Phase 8 — verify from PC

Invoke the `health-check` skill. The new node should turn green.

## Failure modes (lookup table)

- `Permission denied` on `/dev/spidev*` (Pi-A): reboot didn't apply group change, or unit running as wrong user.
- `socket.gaierror: Name or service not known`: `.env` not sourced when manual-running. Use `set -a; source .env; set +a` before `uv run`.
- pylsl `LSL binary library file was not found`: Phase 5 wasn't done.
