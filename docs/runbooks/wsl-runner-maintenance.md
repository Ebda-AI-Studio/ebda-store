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

All workflows use `runs-on: ${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != 'true') && 'ubuntu-latest' || fromJSON('["self-hosted","linux","wsl2"]') }}`,
so `USE_SELF_HOSTED=false` sends every job to GitHub's cloud runners. Flip back
once the runner is healthy:

```bash
gh variable set USE_SELF_HOSTED --body true --repo ForceAI-KW/whatsapp-broadcaster
```

(`notify-failure` jobs always stay on `ubuntu-latest` so alerts fire even when the box is dead.)

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
