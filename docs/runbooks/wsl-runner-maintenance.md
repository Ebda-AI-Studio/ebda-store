# WSL self-hosted GitHub runner — maintenance & parallelism

> # ⛔ OBSOLETE — DO NOT FOLLOW
>
> **There are no Windows/WSL2 runners any more.** All three `windows-wsl-*`
> runners were deleted; every repo now runs CI on **umbra guests** (Apple
> Virtualization.framework VMs on the Mac), not on a Windows PC.
>
> Verified 2026-07-21 — the complete, current set:
>
> | Repo (`ForceAI-KW/…`)   | Runner                            | Host          |
> | ----------------------- | --------------------------------- | ------------- |
> | `force-website-builder` | `fwb-ci5-force-website-builder-1` | umbra fwb-ci5 |
> | `whatsapp-broadcaster`  | `fwb-ci5-whatsapp-broadcaster-1`  | umbra fwb-ci5 |
> | `Force-Media-CRM`       | `fwb-ci5-crm-1`                   | umbra fwb-ci5 |
>
> **The `wsl2` label is vestigial.** These guests still advertise
> `[self-hosted, Linux, ARM64, wsl2, umbra-ci]` purely so existing
> `runs-on: [self-hosted, linux, wsl2]` selectors keep matching. Seeing `wsl2`
> in a workflow does **not** mean a Windows machine is involved.
>
> Re-check the live truth with:
> `gh api repos/ForceAI-KW/<repo>/actions/runners`
>
> Everything below describes decommissioned hardware and is kept only as
> historical context. The sibling scripts in this directory
> (`fix-wsl-runner.sh`, `setup-parallel-runners.sh`) and
> `self-hosted-github-runner-windows.md` are obsolete for the same reason.

---

## Scripts in this folder

> Both scripts are committed here in `docs/runbooks/`. On the runner box they live at
> `/mnt/c/Users/moze1/projects/force-website-builder/docs/runbooks/` (run them via `wsl -d Ubuntu -- bash "<path>"`).

### 1. `fix-wsl-runner.sh` — heal the flaky box (run first)

Fixes the recurring CI infra flakes:

- **DNS** (`Could not resolve host: github.com`) → pins `1.1.1.1`/`8.8.8.8`, stops WSL auto-regenerating `/etc/resolv.conf`.
- **Missing `jq`** (workflows die `exit 127`) → installs it.
- **Docker daemon** not up (integration/E2E service containers fail) → starts it.

```bash
bash fix-wsl-runner.sh          # needs sudo once (your WSL password)
```

### 2. `setup-parallel-runners.sh` — run CI jobs in parallel per project

By default each repo has **one** runner, and a runner runs **one job at a time**
→ a project's CI jobs (lint, typecheck, build, test, e2e) queue up serially, and
one wedged job blocks the whole pipeline. This registers **N runners per repo**
(default **2**, same labels → no workflow YAML changes) so each project runs up to N
jobs at once and a single stuck job can't block it. The box is a **~11 GiB** WSL VM
(heaviest CI job ≈ 5.4 GiB), so runner #1/repo keeps the full 8G/10G budget and each
EXTRA runner gets a tighter 3G/6G/2-core cap. `RUNNERS_PER_REPO=3` (×3 repos = 9
runners) would thrash — bump above 2 only after watching `free -h` during real CI.

```bash
bash setup-parallel-runners.sh            # ensure 2 runners per project
RUNNERS_PER_REPO=4 bash setup-parallel-runners.sh
ONLY_REPO=whatsapp-broadcaster bash setup-parallel-runners.sh
bash setup-parallel-runners.sh --list     # show what's registered
bash setup-parallel-runners.sh --remove   # roll back the extras (keeps #1)
```

Needs `gh` authed in WSL (`gh auth login`) **or** `export GH_PAT=<repo+runner-admin PAT>`.

---

## When a runner is WEDGED (`busy=True` forever, jobs stuck QUEUED)

Cancelling a GitHub run does **not** kill the zombie processes (e.g. a leaked
Jest) on the self-hosted box — so the runner agent still thinks it's busy and
won't accept new jobs. (This pinned WBS for 3h on 2026-06-01.) Recover on the PC:

```bash
pkill -9 -f jest 2>/dev/null; pkill -9 -f Runner.Worker 2>/dev/null
# Service units are actions.runner.ForceAI-KW-<repo>.windows-wsl-<fwb|wbs|crm>.service
sudo systemctl restart 'actions.runner.*' 2>/dev/null \
  || (cd ~/runners/fwb && sudo ./svc.sh stop && sudo ./svc.sh start)   # runners live in ~/runners/{fwb,wbs,crm}
```

**Meanwhile, route CI to cloud so you're not blocked** (from anywhere with `gh`):

```bash
gh variable set USE_SELF_HOSTED --body false --repo ForceAI-KW/whatsapp-broadcaster
```

> **Superseded 2026-10-03 (Ruling CI-CRON-1).** The 2026-09-13 note that cloud
> runners were billing-blocked (so `USE_SELF_HOSTED=false` could not run anything)
> no longer holds: cloud billing is back and FWB runs push/PR/dispatch on cloud
> with `USE_SELF_HOSTED=false` as the current setting. Do not set it to `true` to
> "recover": that moves the full CI matrix and the six `cf-deploy.yml` jobs back
> onto the two-runner pool. If cloud billing is ever blocked again, that is the
> day to flip it to `true`.
>
> **When the guest is sick, fix the guest** (`umbra doctor`, the disk check
> below, `ci-runner-guard.sh`); crons are moved with `SCHEDULED_ON_CLOUD` below.

Every job routes through the toggle, so the switch is ready and no job is
un-movable. Two spellings are in use and both honour it — most jobs carry the
`inputs.force_cloud` term as well, so a `workflow_dispatch` can force cloud for
one run without changing the variable:

```
runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
runs-on: ${{ vars.USE_SELF_HOSTED != 'true' && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
```

**Scheduled runs use a second switch (2026-10-03).** Cloud billing is back
(October allowance) and the FWB repo now runs push/PR/dispatch on cloud
(`USE_SELF_HOSTED=false`). Crons stay on self-hosted because cloud bills each
job at a 1-minute floor and the 30-min/hourly/2-hourly crons alone would use
~2,500 of the month's included minutes. Every workflow with a `schedule:`
trigger reads `vars.SCHEDULED_ON_CLOUD` instead for its cron runs:

```
runs-on: ${{ (inputs.force_cloud || (github.event_name == 'schedule' && vars.SCHEDULED_ON_CLOUD == 'true') || (github.event_name != 'schedule' && vars.USE_SELF_HOSTED != 'true')) && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
```

**Runner outage with crons queued** (db-backup is must-run): move the crons to
cloud with one flip, and flip back when the guest is healthy:

```bash
gh variable set SCHEDULED_ON_CLOUD --body true  --repo ForceAI-KW/force-website-builder
gh variable set SCHEDULED_ON_CLOUD --body false --repo ForceAI-KW/force-website-builder
```

`tests/unit/workflow-runner-selector.test.ts` enforces this: a workflow whose
`runs-on` is neither of those forms — and is not registered there with a reason
— fails the suite. That gate exists because `gitleaks.yml`'s `notify-failure`
was once hardcoded to `[self-hosted, linux, wsl2]`, which silently opted the
secret-leak alert out of this switch. **GitHub does not fail a job whose labels
match no online runner — it queues it for up to ~24h**, and `timeout-minutes`
only starts counting once a runner is assigned. So during exactly the incident
this section is written for, that alert would never have sent and the run would
have shown as still in progress.

Push/PR/dispatch stay on cloud (`USE_SELF_HOSTED=false`) through a runner
outage; only set `USE_SELF_HOSTED` back to `true` if cloud billing is blocked
again.

(`notify-failure` jobs do NOT stay on `ubuntu-latest` — that was true before
the 2026-07-15 Umbra-only CI policy and is no longer. They ride the self-hosted
runner like everything else and move to cloud with this switch. The
runner-is-dead case is alerted by the local OS medic — the `:7717`
runner-offline watch — not by CI, so verify that medic is alive before relying
on CI to tell you the box has gone.)

---

## Recommended first-time / after-reboot sequence (on the PC, in WSL)

```bash
cd ~/projects/force-website-builder/docs/runbooks   # the committed scripts (or /mnt/c/Users/moze1/...)
bash fix-wsl-runner.sh
bash setup-parallel-runners.sh
bash setup-parallel-runners.sh --list
# push/PR/dispatch stay on cloud (USE_SELF_HOSTED=false, Ruling CI-CRON-1); if you moved the
# crons to cloud while the box was down, move them back:
gh variable set SCHEDULED_ON_CLOUD --body false --repo ForceAI-KW/force-website-builder
```

> Tiers: Neon Pro · Cloudflare Workers + Railway Hobby ($10 cap) · GitHub Pro (3000 Actions min/mo).
> Cloud fallback (`USE_SELF_HOSTED=false`) is genuinely cheap on these tiers — self-hosted is a
> cost optimization, not a hard requirement, so prefer flipping to cloud over fighting a sick box.
