#!/usr/bin/env bash
# Phase 4.3: the cutover DRY RUN against LOCAL workerd (wrangler dev) and a scratch Postgres.
#   CUTOVER_PG_URL=postgres://postgres@localhost:54417/<scratch db> bash scripts/cf/rehearse-cutover.sh [workdir]
# Restore the dump into the scratch database first (see docs/runbooks/cutover-cf.md section 3). The source is only
# ever read. Prints a timing table; exits non-zero on the first failed step.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${CUTOVER_PG_URL:?set CUTOVER_PG_URL to the scratch database}"
case "$CUTOVER_PG_URL" in *neon.tech*) echo "refusing: this is a Neon URL; the rehearsal uses a restored copy" >&2; exit 2;; esac
WORK="${1:-$(mktemp -d)}"; PORT="${REHEARSAL_PORT:-8799}"
export CUTOVER_IMPORT_SECRET="${CUTOVER_IMPORT_SECRET:-rehearsal-$(openssl rand -hex 16)}"
export CUTOVER_DO_URL="http://localhost:$PORT"
CFG=packages/cf-migrate/harness/.wrangler.smoke.jsonc
D1=(--d1 ebda-platform --d1-config "$CFG" --persist-to "$WORK/state")
declare -a ROWS
step() { local name="$1"; shift; local t0=$SECONDS; local s0; s0=$(date +%s); "$@" >"$WORK/$name.log" 2>&1 || { echo "STEP FAILED: $name (see $WORK/$name.log)"; tail -15 "$WORK/$name.log"; exit 1; }; ROWS+=("$(printf '%-34s %5ss' "$name" "$(( $(date +%s) - s0 ))")"); }

pkill -f "wrangler dev -c $CFG" 2>/dev/null || true; sleep 1
rm -rf "$WORK/state"; mkdir -p "$WORK/state"
npx wrangler dev -c packages/cf-migrate/harness/.wrangler.smoke.jsonc --persist-to "$WORK/state" --port "$PORT" --var "CUTOVER_IMPORT_SECRET:$CUTOVER_IMPORT_SECRET" >"$WORK/wrangler.log" 2>&1 &
WPID=$!; trap 'kill $WPID 2>/dev/null || true; pkill -f "wrangler dev -c $CFG" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do grep -q "Ready on" "$WORK/wrangler.log" && break; sleep 1; done
grep -q "Ready on" "$WORK/wrangler.log" || { echo "harness did not start"; tail "$WORK/wrangler.log"; exit 1; }

step "1 d1 schema apply"            npx wrangler d1 migrations apply ebda-platform --local -c "$CFG" --persist-to "$WORK/state"
step "2 dry run (read+transform)"   node scripts/cf/migrate-store-to-do.mjs --all --dry-run
step "3 platform -> D1"             node scripts/cf/migrate-platform-to-d1.mjs "${D1[@]}" --archive-dir "$WORK/analytics"
step "4 stores -> StoreDO (all)"    node scripts/cf/migrate-store-to-do.mjs --all --batch rehearsal-1 --report "$WORK/migrate-1.json"
step "5 verify (all stores + D1)"   node scripts/cf/verify-store.mjs --all "${D1[@]}" --report "$WORK/verify-1.json"
step "6 re-run same batch (no-op)"  node scripts/cf/migrate-store-to-do.mjs --all --batch rehearsal-1
step "7 re-run new batch (upsert)"  node scripts/cf/migrate-store-to-do.mjs --all --batch rehearsal-2
step "8 verify again"               node scripts/cf/verify-store.mjs --all "${D1[@]}" --report "$WORK/verify-8.json"
# Flag flip. stores.storage_backend does not exist in cf-schema yet (plan task 2.4 adds it); the rehearsal adds a
# stand-in column so the seal / flip / rollback mechanics are exercised. Remove this step when 2.4 lands.
step "9 stand-in storage_backend"   npx wrangler d1 execute ebda-platform --local -c "$CFG" --persist-to "$WORK/state" --command "ALTER TABLE stores ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'pg'"
step "10 seal + flip to do"         node scripts/cf/flip-backend.mjs --to do --all "${D1[@]}" --verify-report "$WORK/verify-8.json" --yes
if node scripts/cf/migrate-store-to-do.mjs --store storedemo --batch after-seal >"$WORK/11.log" 2>&1; then echo "BUG: import succeeded after seal"; exit 1; fi
grep -q "HTTP 423" "$WORK/11.log" || { echo "expected a 423 after seal"; cat "$WORK/11.log"; exit 1; }
ROWS+=("$(printf '%-34s %s' "11 import after seal" "refused (423)")")
step "12 rollback flip to pg"       node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --yes
echo; echo "verify: $(tail -1 "$WORK/5 verify (all stores + D1).log")"; echo "verify after re-runs: $(tail -1 "$WORK/8 verify again.log")"
echo; printf '%s\n' "${ROWS[@]}"; echo "workdir: $WORK"
