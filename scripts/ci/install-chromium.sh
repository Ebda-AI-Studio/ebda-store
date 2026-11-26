#!/usr/bin/env bash
# install-chromium.sh — the Playwright Chromium the CI tests drive (Ruling CI-MAC-RUNNER-1).
# macOS (the ebda-mac runner): no apt and no --with-deps; the browser lives in the runner's local cache
#   (PLAYWRIGHT_BROWSERS_PATH from the runner .env), so this is a no-op once the pinned revision is there.
# Linux (hosted ubuntu): --with-deps pulls the system libraries over apt. The mirror can fail to resolve for a minute
#   (main run 43034457138 failed every unit shard on "Temporary failure resolving"), so it gets 3 attempts, each capped at 240 s so a hung
#   download fails fast instead of eating the job timeout (Ruling CI-FAILFAST-1).
set -uo pipefail
if [ "$(uname -s)" = Darwin ]; then
  exec npx playwright install chromium
fi
# Runs 45189579070 + 45198255227 (2026-11-23): attempt 1 hit the 240 s cap mid-download; `timeout` killed only npx, the
# orphaned apt-get kept /var/lib/dpkg/lock-frontend, so attempt 2 died instantly with "Could not get lock ... code: 100".
# Fix: apt waits for the lock (DPkg::Lock::Timeout), retries/limits stalled fetches itself, and we wait out any orphan
# apt-get/dpkg (never killed: only PIDs we started) before each retry.
printf 'DPkg::Lock::Timeout "180";\nAcquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
  | sudo tee /etc/apt/apt.conf.d/99ci-retry >/dev/null || true
for attempt in 1 2 3; do
  timeout 240 npx playwright install --with-deps chromium && exit 0
  echo "playwright install --with-deps failed or timed out (attempt $attempt/3)"
  for _ in $(seq 1 36); do pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null || break; sleep 5; done
  sleep 10
done
exit 1
