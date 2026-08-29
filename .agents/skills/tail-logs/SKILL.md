---
name: tail-logs
description: Snapshot the last ~50 lines of logs across the 3-node stack (PC compose services, Pi-A pieeg, Pi-B roomba-state) and highlight any error-shaped lines. Use when the user says "ログ見て" "何が起きてる" "エラーある?".
---

# tail-logs

Parallel fetch (single message, multiple Bash calls):

- `ssh gpu-2-chukei 'cd ~/git/eeg_roomba && docker compose logs --tail 50 ingest feature decision api 2>&1'`
- `ssh pi-a 'journalctl -u pieeg -n 50 --no-pager'`
- `ssh pi-b 'journalctl -u roomba-state -n 50 --no-pager'`

## Report

For each source:
- If clean: one line ("no errors").
- If dirty: list error-shaped lines only (matches `ERROR|Traceback|refused|failed|gaierror|panic|fatal`), prefixed with the source.

Don't paste benign lines. Don't paste the same stacktrace twice — show first frame + last frame.

After the summary, propose **one** specific next action if any errors are present.
