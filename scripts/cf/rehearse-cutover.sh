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

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy (another harness?): set REHEARSAL_PORT" >&2; exit 2; fi
rm -rf "$WORK/state"; mkdir -p "$WORK/state"
npx wrangler dev -c packages/cf-migrate/harness/.wrangler.smoke.jsonc --persist-to "$WORK/state" --port "$PORT" --var "CUTOVER_IMPORT_SECRET:$CUTOVER_IMPORT_SECRET" >"$WORK/wrangler.log" 2>&1 &
WPID=$!; trap 'kill $WPID 2>/dev/null || true' EXIT   # only the PID this script started
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
step "12 rollback (no live writes)" node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --yes
grep -q "loses nothing" "$WORK/12 rollback (no live writes).log" || { echo "expected the no-writes message"; exit 1; }

# ---- Audit DB-1: rollback after LIVE writes (DO + D1) must replay them into Postgres or refuse ----
pgq() { psql "$CUTOVER_PG_URL" -Atc "$1"; }
SID=$(pgq "select id from stores where slug = 'storedemo'")
dosql() { jq -n --arg s "$2" '{sql: $s}' | curl -fsS -X POST -H "authorization: Bearer $CUTOVER_IMPORT_SECRET" -d @- "$CUTOVER_DO_URL/cutover/stores/$1/__sql" >/dev/null; }
expect_fail() { local name="$1" pat="$2"; shift 2; if "$@" >"$WORK/$name.log" 2>&1; then echo "BUG: $name succeeded"; cat "$WORK/$name.log"; exit 1; fi; grep -q "$pat" "$WORK/$name.log" || { echo "BUG: $name failed without '$pat'"; cat "$WORK/$name.log"; exit 1; }; ROWS+=("$(printf '%-34s %s' "$name" "refused as designed")"); }

step "13 flip to do again"          node scripts/cf/flip-backend.mjs --to do --all "${D1[@]}" --verify-report "$WORK/verify-8.json" --yes
# live writes after the flip: a changed row, an added row, a deleted row (DO) and a directory change (D1 + DO mirror)
dosql "$SID" "UPDATE categories SET name = name || ' (live)' WHERE id = (SELECT id FROM categories ORDER BY id LIMIT 1)"
dosql "$SID" "INSERT INTO categories (id, store_id, name, slug) VALUES ('live-cat-1', '$SID', 'Live added', 'live-added')"
dosql "$SID" "DELETE FROM reorder_suggestions WHERE id = (SELECT id FROM reorder_suggestions LIMIT 1)"
dosql "$SID" "UPDATE store_profile SET name = name || ' (live)'"
npx wrangler d1 execute ebda-platform --local -c "$CFG" --persist-to "$WORK/state" --command "UPDATE stores SET name = name || ' (live)' WHERE id = '$SID'" >/dev/null
ROWS+=("$(printf '%-34s %s' "14 live writes (DO + D1)" "4 DO + 1 D1 change made")")
BEFORE=$(pgq "select md5(string_agg(name, ',' order by id)) from categories where store_id = '$SID'")

expect_fail "15 rollback, no replay url" "rollback REFUSED" node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --yes
[ "$(pgq "select md5(string_agg(name, ',' order by id)) from categories where store_id = '$SID'")" = "$BEFORE" ] || { echo "BUG: postgres changed"; exit 1; }

# a live-side value Postgres has no column for (orders.buyer_key) cannot be carried back: refuse + roll the replay back
OSTORE=$(pgq "select store_id from orders limit 1"); dosql "$OSTORE" "UPDATE orders SET buyer_key = 'cafebabe' WHERE id = (SELECT id FROM orders LIMIT 1)"
expect_fail "16 rollback, unreplayable data" "replay FAILED and was rolled back" node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --replay-pg-url "$CUTOVER_PG_URL" --yes
[ "$(pgq "select md5(string_agg(name, ',' order by id)) from categories where store_id = '$SID'")" = "$BEFORE" ] || { echo "BUG: failed replay left rows in postgres"; exit 1; }
dosql "$OSTORE" "UPDATE orders SET buyer_key = NULL WHERE buyer_key = 'cafebabe'"

# store fence: a DO row that claims ANOTHER store's id must abort the replay and leave Postgres untouched
OTHER=$(pgq "select id from stores where slug = 'qa-walk-store-1010'")
dosql "$SID" "INSERT INTO categories (id, store_id, name, slug) VALUES ('evil-cat-1', '$OTHER', 'claims another store', 'evil-x')"
expect_fail "16b rollback, foreign-store row" "claims store" node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --replay-pg-url "$CUTOVER_PG_URL" --yes
[ "$(pgq "select count(*) from categories where id = 'evil-cat-1'")" = 0 ] || { echo "BUG: foreign-store row reached postgres"; exit 1; }
[ "$(pgq "select md5(string_agg(name, ',' order by id)) from categories where store_id = '$SID'")" = "$BEFORE" ] || { echo "BUG: fenced replay changed postgres"; exit 1; }
dosql "$SID" "DELETE FROM categories WHERE id = 'evil-cat-1'"

step "17 rollback + replay to pg"   node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --replay-pg-url "$CUTOVER_PG_URL" --yes
grep -q "replay committed" "$WORK/17 rollback + replay to pg.log" || { echo "replay did not commit"; exit 1; }
[ "$(pgq "select count(*) from categories where id = 'live-cat-1'")" = 1 ] || { echo "BUG: added row not in postgres"; exit 1; }
step "18 verify pg == live side"    node scripts/cf/verify-store.mjs --all "${D1[@]}"
step "19 reset DO for a retry"      node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --replay-pg-url "$CUTOVER_PG_URL" --reset-do --yes
step "20 re-import after reset"     node scripts/cf/migrate-store-to-do.mjs --all --batch rehearsal-retry
step "21 verify the retry"          node scripts/cf/verify-store.mjs --all "${D1[@]}"
echo; echo "verify: $(tail -1 "$WORK/5 verify (all stores + D1).log")"; echo "verify after re-runs: $(tail -1 "$WORK/8 verify again.log")"
echo; printf '%s\n' "${ROWS[@]}"; echo "workdir: $WORK"
