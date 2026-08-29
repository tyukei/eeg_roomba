---
name: ship
description: End-to-end "ship this change" pipeline — branch, commit, push, open PR, parallel self-review, apply review fixes, squash-merge, then invoke /deploy-all. Use when the user says "ship" "出荷" "全部やって" or after they've approved a set of local changes and want the full release flow.
---

# ship

Use this when the user has working-tree changes (or a feature branch) they want to release end-to-end without manual hand-offs. The skill is opinionated: PR-based, squash merge, deploy via `deploy-all`.

## Preconditions

- Working tree has the change you want to ship (staged or unstaged is fine — the skill stages selectively).
- `gh` CLI is authenticated.
- You can `gh pr merge --squash --admin` (the auto-mode classifier accepts `--admin` after a fresh PR for this repo's solo-dev pattern; without it, the merge will be blocked and the user has to do it).
- `/deploy-all` skill exists.

## Steps

### 1. Sanity + branch

- If currently on `main` and there are uncommitted changes, create a feature branch named from the diff context: `git checkout -b <type>/<short-slug>`. Type is one of `feat|fix|chore|refactor|docs`.
- If already on a non-`main` branch, keep it.

### 2. Stage + commit

- `git status --short` to enumerate files.
- Stage only project files. **Never** stage `package-lock.json` if it wasn't already tracked, dotfiles unrelated to the change, or `.env`.
- Build a commit message — short imperative subject (≤72 chars) + a body explaining *why*. Use the conventional prefix matching the branch type.
- Commit, ending with the `Co-Authored-By` line.

### 3. Build / test gate

Run whatever validations apply to the changes:
- Frontend changes → `cd frontend && npx tsc --noEmit && npx vite build`
- Python service changes → `cd <service> && uv run pytest` (if tests exist)
- If any check fails, **stop**. Do not push. Tell the user what broke.

### 4. Push + PR

- `git push -u origin <branch>`
- `gh pr create --title "..." --body "$(cat <<'EOF' ... EOF)"` — use a HEREDOC for the body. Include a "Summary" and "Test plan" section. End with the `🤖 Generated with [Codex]` footer.
- Capture the PR number and URL.

### 5. Parallel self-review

Spawn 2–3 **review subagents in parallel** in one message. Each gets a self-contained prompt naming the PR # and the kind of review:

- **`code-review`** (Explore + reasoning): "Review PR #N for correctness, dead code, unsafe patterns. Cite file:line. Under 250 words. No code edits."
- **`ui-review`** (only if frontend files changed): "Review PR #N as a UX/visual critic. Identify inconsistency, accessibility, alignment, color-contrast issues. Cite file:line. Under 250 words. No code edits."
- **`security-review`** (only if backend / auth / env files changed): "Review PR #N for OWASP-style issues, secret leaks, SQL/command injection, unsafe deserialization. Cite file:line. Under 200 words. No code edits."

> Do not spawn `ultrareview` — that is user-triggered and billed separately.

### 6. Apply review fixes

Collect the reviewers' findings. Decide which are worth fixing in this PR vs deferring:
- **Fix now**: anything correctness, security, or blocking-UX. Type-checking / lint regressions. Inconsistencies the reviewer flagged with high confidence.
- **Defer**: nits, hypothetical future concerns, stylistic preferences that didn't have a clear win.

Make the edits, re-run the build/test gate from step 3, then `git commit` + `git push` to the same branch.

### 7. Merge

```
gh pr merge <N> --squash --delete-branch --admin
```

If the classifier blocks even with `--admin`, **stop and tell the user**. Do not attempt rollback / force.

### 8. Deploy

Invoke the `/deploy-all` skill (which is itself parallel across the 3 nodes). It will confirm the SHA and report per-node outcome.

## After

Report back with:
- PR URL and merged SHA
- 1-line summary of each reviewer's main finding and what you did about it
- `/deploy-all` per-node outcome

## Failure handling

- Build/test fail in step 3 → stop, surface output to user.
- Push or PR-create fails → stop, surface error.
- Reviewer flagged a correctness issue but you can't reproduce it → comment on the PR with `gh pr comment <N> --body "..."` explaining your reasoning, fix the fixable ones, and proceed.
- Merge blocked → stop, give the user the PR URL.
- Deploy fails on one node → keep PR merged (the change is good), surface the deploy error so the user can decide whether to retry or roll back.

## Parallelization rules

- The 3 reviewer subagents go in one Agent batch (one assistant turn with multiple Agent tool calls).
- The 3 deploy ssh agents go in one Agent batch (handled by `/deploy-all`).
- Build/test in step 3 can be parallel if independent (e.g., `tsc --noEmit` and `vite build` are sequential but `cd a && pytest` + `cd b && pytest` are not).

## Anti-patterns (don't)

- Don't open a PR before the build/test gate passes — the reviewers will see broken code.
- Don't `--no-verify` to skip hooks.
- Don't `git push --force` to a shared branch.
- Don't run `/ultrareview` from inside this skill (it's billed).
- Don't merge without at least one reviewer pass — even on small changes, the reviewer catches typos and stale comments.
