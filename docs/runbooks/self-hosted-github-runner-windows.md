# Self-hosted GitHub Actions runner on Windows

> One-time setup. Goal: run CI on Ahmad's Windows PC instead of GitHub-cloud, so we never burn cloud minutes again when the monthly cap exhausts. Three Force AI repos use this: FWB, WBS, Force-Media-CRM.

## Two paths — pick one

### **Path A — WSL2 (RECOMMENDED)** ✅

Install WSL2 (Windows Subsystem for Linux) once on the Windows PC, then run a single Ubuntu-flavored runner inside it. **All workflows continue to use `runs-on: ubuntu-latest` with zero edits** because the runner advertises itself as Linux. Postgres + Redis service containers work natively via Docker Desktop's WSL2 backend, bash scripts run as-is.

This is what we're doing. Skip Path B unless you tried WSL2 and hit a wall.

### Path B — Native Windows runner (fallback)

Only useful if WSL2 won't install (very old hardware or corp-locked Windows). Requires editing every workflow file to split jobs: cheap stuff (lint, typecheck, audit) → self-hosted; postgres-needing stuff (integration tests) → stays on `ubuntu-latest`. Skipped here — ask if you need it.

---

## Path A — WSL2 runner setup

### 1. Install WSL2 + Ubuntu (one-time, ~5 min)

Open **PowerShell as Administrator** on the Windows PC:

```powershell
wsl --install -d Ubuntu-22.04
```

This installs WSL2 + an Ubuntu 22.04 distro. Restart the PC when prompted. After reboot, an Ubuntu terminal opens automatically and asks for a username + password — pick whatever, e.g. `ahmad` / your usual password.

### 2. Install Docker Desktop for Windows (one-time, ~5 min)

Why: GitHub Actions service containers (postgres, redis) run as Docker containers. WSL2 doesn't bundle Docker by default, but Docker Desktop has a "WSL2 integration" that exposes the daemon to your Ubuntu distro.

1. Download: https://www.docker.com/products/docker-desktop/
2. Install with defaults (it auto-enables the WSL2 backend)
3. After install: Docker Desktop → Settings → **Resources → WSL Integration** → toggle ON for `Ubuntu-22.04`
4. Restart Ubuntu terminal — `docker ps` should now work inside WSL

### 3. Install Node.js 20 LTS inside WSL (one-time, ~2 min)

From the Ubuntu terminal:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
node -v   # should print v20.x.x
npm -v
```

### 4. Get a registration token per repo

On a machine with `gh` CLI authenticated (your Mac):

```bash
# FWB
gh api -X POST repos/ForceAI-KW/force-website-builder/actions/runners/registration-token --jq '.token'

# WBS
gh api -X POST repos/ForceAI-KW/whatsapp-broadcaster/actions/runners/registration-token --jq '.token'

# CRM
gh api -X POST repos/ForceAI-KW/force-media-crm/actions/runners/registration-token --jq '.token'
```

Each token is valid for ~1 hour. Copy them to a notes file temporarily.

> ⚠️ If a repo name is different from above, fix it. Check via `gh repo list ForceAI-KW`.

### 5. Install the runner inside WSL (3 runners, ~3 min each)

From the Ubuntu terminal:

```bash
# FWB runner
mkdir -p ~/runners/fwb && cd ~/runners/fwb
curl -o actions-runner-linux.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-x64-2.319.1.tar.gz
tar xzf actions-runner-linux.tar.gz
./config.sh \
  --url https://github.com/ForceAI-KW/force-website-builder \
  --token <FWB-TOKEN-FROM-STEP-4> \
  --name windows-wsl-fwb \
  --labels self-hosted,linux,wsl2 \
  --unattended

# WBS runner
mkdir -p ~/runners/wbs && cd ~/runners/wbs
curl -o actions-runner-linux.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-x64-2.319.1.tar.gz
tar xzf actions-runner-linux.tar.gz
./config.sh \
  --url https://github.com/ForceAI-KW/whatsapp-broadcaster \
  --token <WBS-TOKEN-FROM-STEP-4> \
  --name windows-wsl-wbs \
  --labels self-hosted,linux,wsl2 \
  --unattended

# CRM runner — same pattern, skip if not using CI on CRM
```

### 6. Start each runner as a systemd service (always-on)

```bash
# For each runner directory:
cd ~/runners/fwb
sudo ./svc.sh install
sudo ./svc.sh start

cd ~/runners/wbs
sudo ./svc.sh install
sudo ./svc.sh start
```

These survive reboots (provided WSL is started — WSL launches on Windows login by default with WSL2's `systemd: true` setting).

If `svc.sh` complains about systemd not running:

```bash
# Ensure WSL has systemd enabled (Ubuntu 22.04 supports it natively)
sudo tee /etc/wsl.conf > /dev/null <<EOF
[boot]
systemd=true
EOF
# Then from Windows PowerShell: wsl --shutdown
# Reopen Ubuntu — systemd will now be running
```

### 7. Verify each runner registered

GitHub UI: https://github.com/ForceAI-KW/force-website-builder/settings/actions/runners

You should see `windows-wsl-fwb` with status **Idle** (green dot). Same check for each repo.

CLI verification from your Mac:

```bash
gh api repos/ForceAI-KW/force-website-builder/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

### 8. Route workflows to the self-hosted runner

Two options:

**Option A — auto-route everything** (saves the most cloud minutes, but Docker Desktop must stay running on Windows so postgres service containers work)

Edit each workflow's `runs-on:`:

```yaml
# Before:
jobs:
  lint:
    runs-on: ubuntu-latest

# After:
jobs:
  lint:
    runs-on: [self-hosted, linux, wsl2]
```

GitHub matches when ALL listed labels are present, so the workflow lands on the WSL2 runner.

**Option B — route everything except deploys/token-exfil** (current policy as of 2026-05-28)

With Docker installed in WSL2, postgres and redis service containers work on the self-hosted runner.
Flip lint / typecheck / audit / gitleaks / **integration tests** to self-hosted. Keep on `ubuntu-latest`:
deploys (`railway up`, `vercel deploy`, `gh release create`), npm publish, Telegram `notify-failure`
(must survive runner-offline), and any job that exfiltrates via a third-party token (Sentry release
upload, OneSignal admin push, Resend API key, Vercel API). Playwright/E2E: conservative default —
keep on cloud until browser download is verified inside WSL2 (decide per repo).

```yaml
jobs:
  lint:
    runs-on: [self-hosted, linux, wsl2]
  typecheck:
    runs-on: [self-hosted, linux, wsl2]
  audit:
    runs-on: [self-hosted, linux, wsl2]
  gitleaks:
    runs-on: [self-hosted, linux, wsl2]
  integration:
    runs-on: [self-hosted, linux, wsl2] # Docker-in-WSL supplies postgres + redis service containers
  e2e:
    runs-on: ubuntu-latest # playwright install downloads browsers; leave on cloud for now
  deploy:
    runs-on: ubuntu-latest # token-exfil (RAILWAY_TOKEN / VERCEL_TOKEN) — stays on cloud
  notify-failure:
    runs-on: ubuntu-latest # must fire even when self-hosted runner is offline
```

That covers ~75-80% of CI minutes with Docker unblocking the previously cloud-only integration jobs.

### 9. Smoke test

Push any commit to a PR branch. Watch the Actions tab — jobs targeted at self-hosted should pick up the `windows-wsl-fwb` runner. Logs will show:

```
Current runner version: '2.319.1'
Operating system: Linux 5.15.x (WSL2)
Runner Image: self-hosted
```

If a job sits **queued** for >2 min, the runner isn't picking it up. Check `sudo systemctl status actions.runner.ForceAI-KW-force-website-builder.windows-wsl-fwb.service` inside Ubuntu.

## Maintenance

| Task                         | How                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Pause the runner             | `sudo ./svc.sh stop` from the runner dir                                                           |
| Resume                       | `sudo ./svc.sh start`                                                                              |
| Update to new runner version | `cd ~/runners/fwb && sudo ./svc.sh stop && ./config.sh remove --token <fresh-token>` + redo step 5 |
| Unregister                   | `./config.sh remove --token <fresh-deregister-token>` (`gh api -X POST .../remove-token`)          |
| Watch logs                   | `tail -f ~/runners/fwb/_diag/Runner_*.log`                                                         |
| Check WSL is running         | From PowerShell: `wsl --list --running`                                                            |

## Why not native Windows runner?

Because all our workflows assume Linux: bash scripts in `package.json`, postgres service containers, `actions/checkout` with bash steps, `npm ci` paths, gitleaks Action (Linux-only binary). Running native Windows means editing every workflow + maintaining a Windows-specific code path. WSL2 sidesteps all of it.

If you ever need to drop to native Windows (rare — only if WSL2 + Docker Desktop become impossible), we'd:

1. Install the Windows runner via `actions-runner-win-x64-*.zip`
2. Add `runs-on: [self-hosted, windows]` to ONLY the lint / typecheck / audit jobs
3. Keep integration / E2E / build on `ubuntu-latest` (GitHub-cloud)
4. Accept that we still burn some cloud minutes

Skip unless absolutely necessary.

## Why this matters (sanity check)

- GitHub-cloud free tier: 2000 minutes/month on private repos, then $0.008/min Linux / $0.016/min Windows
- A typical FWB CI run is 8-15 min across all jobs
- Burning the cap takes ~130-250 runs/month at current cadence (multiple PRs/day)
- This setup: zero cloud minutes for self-hosted jobs, only paying for the WSL2 runner's electricity. Mac sleeps fine; the Windows PC needs to be on for runs to dispatch, but jobs queue when offline and pick up when it wakes.

## Related

- `.github/workflows/ci.yml` — main CI workflow per repo
- `~/.claude/projects/-Users-ahmadsharaf/memory/feedback-force-ai-ci-cd-standard.md` — canonical CI shape for all Force AI repos
