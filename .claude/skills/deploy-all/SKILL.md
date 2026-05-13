---
name: deploy-all
description: Pull latest main and restart services on all 3 nodes (PC docker compose, Pi-A pieeg, Pi-B roomba-state). Use when the user says "deploy" "全台反映" "全部更新" "rollout".
---

# deploy-all

Preconditions:
- main is up-to-date on origin (push first if not).
- All 3 nodes have the repo cloned and systemd units installed.

## Steps

1. **Confirm with the user** the commit SHA being deployed:
   ```bash
   git log -1 --oneline origin/main
   ```

2. **Fan out** by launching three parallel `Agent` calls in a single message. Each agent gets a self-contained prompt with the exact ssh command and reports back tersely.

   - Agent: "PC deploy"
     ```
     ssh gpu-2-chukei 'cd ~/git/eeg_roomba && git pull --ff-only && docker compose up -d --build && docker compose ps'
     ```
   - Agent: "Pi-A deploy"
     ```
     ssh pi-a 'cd ~/Documents/eeg_roomba && git pull --ff-only && cd pi_a_acquirer && uv sync --frozen && sudo systemctl restart pieeg && systemctl is-active pieeg'
     ```
   - Agent: "Pi-B deploy"
     ```
     ssh pi-b 'cd ~/Documents/eeg_roomba && git pull --ff-only && cd pi_b_roomba_addon && uv sync --frozen && sudo systemctl restart roomba-state && systemctl is-active roomba-state'
     ```

3. After all three return, invoke the `health-check` skill and report the diff (what changed since pre-deploy).

## Failure handling

- If one node fails: report which one + 20 lines of `journalctl` / `docker compose logs`.
- Do **not** attempt rollback automatically. Ask the user before `git reset` on a remote.
