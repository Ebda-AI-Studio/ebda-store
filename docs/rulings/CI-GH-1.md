# CI-GH-1

> Section: 2026-10-03 — Sentry backlog batch (branch `fix/followups13`, issues 2469–2473)

## Ruling CI-GH-1 — the self-hosted runners have no `gh`; the blast-radius comment uses the REST API (issue 2452, 2026-10-03)

Decision: `.github/workflows/blast-radius.yml` posts its PR comment with python3 and the REST API (the same endpoints `.github/scoped-audit/audit.mjs` uses), logs an explicit `::warning::` when the comment cannot be posted, and no longer relies on `continue-on-error` to hide a 127. The check itself (the compute step and the step summary) is unchanged. Partial: the other `gh`-using workflows were not changed.
Evidence: the last run on `ebda-ci6` logged `gh: command not found` in the comment step while every step reported success. `auto-fix-watchdog.yml` is the other `gh` user that can land on a self-hosted runner (its `schedule:` path); it installs `jq` for itself but nothing installs `gh`, and its recent scheduled runs report success, so whether it works there was not verified. `runner-health-check.yml` and `cloud-rescue.yml` are `ubuntu-latest` only.
Cost if wrong: if `gh` is also missing for the watchdog's scheduled runs, its stale-failure escalation never fires; `gh --version` on a `ebda-ci` runner settles it.
