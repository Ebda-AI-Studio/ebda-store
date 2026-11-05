#!/usr/bin/env bash
# Retention rules for the cf/ backups (Ruling NZ-BACKUP-1). A CONTROLLER RUNBOOK STEP: this changes the production bucket, so it
# only prints the commands unless run with --apply. Daily 7 d, weekly 28 d, monthly 93 d. The Neon final dump under final/ and the
# legacy db/ rule are NOT touched. cf/ledger.json + cf/latest.json sit outside these prefixes and are overwritten every night.
set -euo pipefail
BUCKET="${BUCKET:-ebda-db-backups}"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
run() { echo "+ $*"; [ "$APPLY" = 1 ] && "$@" || true; }
run npx wrangler r2 bucket lifecycle add "$BUCKET" cf-daily-7d   --prefix cf/daily/   --expire-days 7
run npx wrangler r2 bucket lifecycle add "$BUCKET" cf-weekly-28d --prefix cf/weekly/  --expire-days 28
run npx wrangler r2 bucket lifecycle add "$BUCKET" cf-monthly-93d --prefix cf/monthly/ --expire-days 93
echo "afterwards: npx wrangler r2 bucket lifecycle list $BUCKET   (final/ must still have NO expiry rule)"
