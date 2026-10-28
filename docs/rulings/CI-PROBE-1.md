# CI-PROBE-1

> Section: Backlog batch g-ci-scripts-other (2026-10-01)

**Ruling CI-PROBE-1 — the hourly guest-checkout probe stays on the repo's runner expression, not
`ubuntu-latest` (issue 2191).** Cloud Actions minutes are billing-blocked for this org
(`runner-health-check.yml` header: a hosted job fails in ~3s with 0 steps), so pinning the probe to
`ubuntu-latest` would turn it into an hourly red that alerts nobody. A run that never starts because
the self-hosted runner is offline is detected outside GitHub Actions by `ci-runner-guard.sh`
(launchd, every 30 min, Telegram). The retry half of 2191 is fixed: both probe copies are now one
script. Cost if wrong: if `ci-runner-guard.sh` itself stops, a dead runner silences this probe and
every other scheduled job until someone opens the Actions tab.
