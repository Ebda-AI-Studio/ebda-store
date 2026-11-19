#!/usr/bin/env bash
# install-chromium.sh — the Playwright Chromium the CI tests drive (Ruling CI-MAC-RUNNER-1).
# macOS (the ebda-mac runner): no apt and no --with-deps; the browser lives in the runner's local cache
#   (PLAYWRIGHT_BROWSERS_PATH from the runner .env), so this is a no-op once the pinned revision is there.
# Linux (hosted ubuntu): --with-deps pulls the system libraries over apt. The mirror can fail to resolve for a minute
#   (main run 43034457138 failed every unit shard on "Temporary failure resolving"), so it gets 3 attempts.
set -uo pipefail
if [ "$(uname -s)" = Darwin ]; then
  exec npx playwright install chromium
fi
for attempt in 1 2 3; do
  npx playwright install --with-deps chromium && exit 0
  echo "playwright install --with-deps failed (attempt $attempt/3)"; sleep $((attempt * 20))
done
exit 1
