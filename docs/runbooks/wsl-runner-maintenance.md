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

> **Do not flip this during an incident — it is not a recovery action today.**
>
> GitHub-hosted runners are **billing-blocked for this org**. Verified
> 2026-09-13: the only two `ubuntu-latest` jobs are `cloud-rescue.yml` (marked
> OBSOLETE) and `runner-health-check.yml`, whose last four runs — all
> 2026-07-21 — failed, and whose own header records that on blocked billing it
> "fails in ~3s every 15 min and alerts nobody". Setting `USE_SELF_HOSTED=false`
> therefore does not move work to runners that can execute it; it moves work to
> a pool that cannot, silently disabling ALL CI for this repo — including
> `db-backup.yml`, which the same page documents as must-run.
>
> **When the guest is sick, fix the guest** (`umbra doctor`, the disk check
> below, `ci-runner-guard.sh`). The toggle is the lever for the day cloud
> billing is restored, not for today.

Every job routes through the toggle, so the switch is ready and no job is
un-movable. Two spellings are in use and both honour it — most jobs carry the
`inputs.force_cloud` term as well, so a `workflow_dispatch` can force cloud for
one run without changing the variable:

```
runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
runs-on: ${{ vars.USE_SELF_HOSTED != 'true' && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}
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

If cloud billing is ever restored, flip back once the runner is healthy:

```bash
gh variable set USE_SELF_HOSTED --body true --repo ForceAI-KW/whatsapp-broadcaster
```

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
# then, if you'd flipped CI to cloud while the box was down:
for r in force-website-builder whatsapp-broadcaster Force-Media-CRM; do
  gh variable set USE_SELF_HOSTED --body true --repo ForceAI-KW/$r
done
```

> Tiers: Neon Pro · Cloudflare Workers + Railway Hobby ($10 cap) · GitHub Pro (3000 Actions min/mo).
> Cloud fallback (`USE_SELF_HOSTED=false`) is genuinely cheap on these tiers — self-hosted is a
> cost optimization, not a hard requirement, so prefer flipping to cloud over fighting a sick box.
