---
name: health-check
description: Survey health of the 3-node eeg_roomba stack (PC docker compose, Pi-A pieeg, Pi-B roomba-state) and report a one-screen status table. Use when the user asks "状態?" "ヘルスチェック" "health" "全体どう?" or before/after deploys.
---

# health-check

Goal: a single status table the user can scan in one breath.

## Steps

Run all four checks **in parallel** (single message, multiple Bash tool calls):

1. `ssh pc "cd ~/git/eeg_roomba && docker compose ps --format '{{.Service}}\t{{.Status}}'"`
2. `ssh pi-a 'echo PIEEG=$(systemctl is-active pieeg); journalctl -u pieeg -n 3 --no-pager'`
3. `ssh pi-b 'echo ROOMBA_STATE=$(systemctl is-active roomba-state); echo ROOMBA_API=$(systemctl is-active roomba-api); journalctl -u roomba-state -n 3 --no-pager'`
4. `ssh pc 'docker exec eeg_roomba-mosquitto-1 mosquitto_sub -h localhost -t pieeg/health -t roomba/state -t control/state -C 3 -W 2'`

## Report format

A compact table:

```
node      service           status     note
PC        timescaledb       healthy
PC        api               up         200 /healthz
Pi-A      pieeg             active     250 samples/s
Pi-B      roomba-state      active     online:true
Pi-B      roomba-api        active     (existing)
MQTT      pieeg/health      retained   online:true
MQTT      roomba/state      retained   online:true
MQTT      control/state     retained   idle
```

If anything is off:
- name the symptom
- propose **one** specific next command (don't dump full logs)

Never run destructive commands; this skill is read-only.
