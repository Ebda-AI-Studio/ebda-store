#!/usr/bin/env bash
# Installs the off-account backup pull (Ruling ICEBERG-BK-3) as a launchd job on this Mac: daily 08:05 local, after the
# 02:17 UTC cf-backup.yml run. Copies the script out of the repo (a worktree can disappear; the root checkout may lag main), so
# re-run this after the script changes. Lives here, not in ebda-foundation/ops/, because ebda-foundation has no ops/install.sh
# pattern yet (checked 2026-11-10: ops/ holds host-lock + merge-gate only).
#
# Before the first run, store a Cloudflare API token with "Workers R2 Storage: Read" ONLY in the Keychain:
#   security add-generic-password -a "$USER" -s ebda-r2-backup-read -w '<token>'
# Uninstall: launchctl bootout gui/$(id -u)/app.ebda.cf-backup-pull; rm ~/Library/LaunchAgents/app.ebda.cf-backup-pull.plist
set -euo pipefail
LABEL=app.ebda.cf-backup-pull
SRC="$(cd "$(dirname "$0")" && pwd)/pull-cf-backups.mjs"
DEST_DIR="$HOME/Library/Application Support/ebda-ops"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ebda-cf-backup-pull.log"
NODE="$(command -v node)"
mkdir -p "$DEST_DIR" "$HOME/Library/LaunchAgents"
install -m 0755 "$SRC" "$DEST_DIR/pull-cf-backups.mjs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/caffeinate</string><string>-i</string><string>$NODE</string><string>$DEST_DIR/pull-cf-backups.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>5</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL -> $DEST_DIR/pull-cf-backups.mjs (log $LOG)"
security find-generic-password -s ebda-r2-backup-read >/dev/null 2>&1 \
  || echo "WARNING: Keychain item ebda-r2-backup-read is missing: the job will alert and pull NOTHING until it exists"
echo "first run now: launchctl kickstart gui/$(id -u)/$LABEL && tail -f '$LOG'"
