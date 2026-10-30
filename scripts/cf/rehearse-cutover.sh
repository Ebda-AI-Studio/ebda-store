#!/usr/bin/env bash
# The cutover rehearsal (docs/runbooks/cutover-cf.md section 3): the WHOLE sequence against LOCAL workerd (wrangler dev,
# StoreDO with the generated schema, local D1) and a scratch restore of the newest dump. It prints one PASS line.
#
#   bash scripts/cf/rehearse-cutover.sh [workdir]
#
# NEVER production: no Neon URL is accepted anywhere (the script refuses one), nothing is deployed, no remote D1 or
# DO is touched. Postgres is a throwaway cluster THIS script initialises under the workdir and stops again (only
# the cluster it started, by its own data directory). Inputs, all optional:
#   REHEARSAL_DUMP   a .sql.gz to restore (default: the newest in ~/Desktop/projects/_backups/ebda/)
#   CUTOVER_PG_URL   an existing scratch database to use instead of starting one (never a *.neon.tech host)
#   REHEARSAL_PORT   workerd port (default 8799)
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${CUTOVER_PG_URL:-}" in *neon.tech*) echo "refusing: this is a Neon URL; the rehearsal uses a restored copy" >&2; exit 2;; esac
WORK="${1:-$(mktemp -d)}"; PORT="${REHEARSAL_PORT:-8799}"
mkdir -p "$WORK"
T_ALL=$SECONDS
PGBIN=/opt/homebrew/opt/postgresql@17/bin
PGSTARTED=""
cleanup() {
  [ -n "${WPID:-}" ] && kill "$WPID" 2>/dev/null || true            # only the PID this script started
  [ -n "$PGSTARTED" ] && "$PGBIN/pg_ctl" -D "$WORK/pg" -m fast stop >/dev/null 2>&1 || true   # only the cluster it initialised
}
trap cleanup EXIT

# ---- scratch Postgres from the newest dump ----
if [ -z "${CUTOVER_PG_URL:-}" ]; then
  DUMP="${REHEARSAL_DUMP:-$(ls -t "$HOME"/Desktop/projects/_backups/ebda/*.sql.gz 2>/dev/null | head -1)}"
  [ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "no dump: put one in ~/Desktop/projects/_backups/ebda/ or set REHEARSAL_DUMP" >&2; exit 2; }
  [ -x "$PGBIN/initdb" ] || { echo "postgresql@17 not installed ($PGBIN)" >&2; exit 2; }
  PGPORT_R=$(( 54500 + RANDOM % 400 )); while lsof -iTCP:"$PGPORT_R" -sTCP:LISTEN >/dev/null 2>&1; do PGPORT_R=$(( 54500 + RANDOM % 400 )); done
  rm -rf "$WORK/pg"; "$PGBIN/initdb" -D "$WORK/pg" -U postgres --auth=trust -E UTF8 >"$WORK/initdb.log" 2>&1
  "$PGBIN/pg_ctl" -D "$WORK/pg" -o "-p $PGPORT_R -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" -w start >/dev/null
  PGSTARTED=1
  "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT_R" -U postgres ebda_cutover_rehearsal
  export CUTOVER_PG_URL="postgres://postgres@127.0.0.1:$PGPORT_R/ebda_cutover_rehearsal"
  gunzip -c "$DUMP" | "$PGBIN/psql" -q -h 127.0.0.1 -p "$PGPORT_R" -U postgres -d ebda_cutover_rehearsal >"$WORK/restore.log" 2>&1 || true
  N_STORES=$(psql "$CUTOVER_PG_URL" -Atc "select count(*) from stores" 2>/dev/null || echo 0)
  [ "$N_STORES" -gt 0 ] || { echo "restore produced no stores (see $WORK/restore.log)" >&2; exit 1; }
  echo "scratch restore: $(basename "$DUMP") -> $N_STORES stores, $(psql "$CUTOVER_PG_URL" -Atc 'select count(*) from orders') orders"
else
  DUMP="(CUTOVER_PG_URL)"
fi

# ---- the cutover secret (Ruling CUTOVER-2: 24+ chars, set on the Worker, bearer-checked before the DO sees a request) ----
export CUTOVER_IMPORT_SECRET="${CUTOVER_IMPORT_SECRET:-rehearsal-$(openssl rand -hex 16)}"
export CUTOVER_DO_URL="http://localhost:$PORT"
CFG=packages/cf-migrate/harness/.wrangler.smoke.jsonc
D1=(--d1 ebda-platform --d1-config "$CFG" --persist-to "$WORK/state")
declare -a ROWS
step() { local name="$1"; shift; local t0=$SECONDS; local s0; s0=$(date +%s); "$@" >"$WORK/$name.log" 2>&1 || { echo "STEP FAILED: $name (see $WORK/$name.log)"; tail -15 "$WORK/$name.log"; exit 1; }; ROWS+=("$(printf '%-34s %5ss' "$name" "$(( $(date +%s) - s0 ))")"); }

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy (another harness?): set REHEARSAL_PORT" >&2; exit 2; fi
rm -rf "$WORK/state"; mkdir -p "$WORK/state"
npx wrangler dev -c packages/cf-migrate/harness/.wrangler.smoke.jsonc --persist-to "$WORK/state" --port "$PORT" --var "CUTOVER_IMPORT_SECRET:$CUTOVER_IMPORT_SECRET" >"$WORK/wrangler.log" 2>&1 &
WPID=$!   # cleanup() stops only this PID
for _ in $(seq 1 60); do grep -q "Ready on" "$WORK/wrangler.log" && break; sleep 1; done
grep -q "Ready on" "$WORK/wrangler.log" || { echo "harness did not start"; tail "$WORK/wrangler.log"; exit 1; }

# ---- gates that are code, not a manual look: coverage (every table mapped + erasure-classified), the 501/NOT_ON_DO
# error-code guard, the write freeze (HTTP, jobs, queues, alarms), rollback replay ownership, the Neon decommission guards ----
# the app tests import the built workspace packages (CI builds them the same way); a fresh worktree has neither
[ -f packages/database/dist/index.js ] || step "0 build database pkg" npm run build -w packages/database
[ -f packages/shared/dist/index.js ] || step "0 build shared pkg" npm run build -w packages/shared
step "0a coverage + migrate gates"  npx vitest run packages/cf-migrate
step "0b NOT_ON_DO + freeze guards" npx vitest run tests/unit/checkout-error-code-coverage.test.ts tests/unit/jobs-freeze.test.ts apps/api/src/middleware/__tests__/write-freeze.test.ts
# ---- CUTOVER_IMPORT_SECRET: no bearer and a wrong bearer are both refused before the DO sees the request ----
ZERO=00000000-0000-0000-0000-000000000000
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CUTOVER_DO_URL/cutover/stores/$ZERO/__import")" = 401 ] || { echo "BUG: unauthenticated __import was not 401"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'authorization: Bearer wrong-wrong-wrong-wrong-wrong' "$CUTOVER_DO_URL/cutover/stores/$ZERO/__import")" = 401 ] || { echo "BUG: wrong bearer was not 401"; exit 1; }
ROWS+=("$(printf '%-34s %s' "0c secret: none/wrong bearer" "401 / 401")")

step "1 d1 schema apply"            npx wrangler d1 migrations apply ebda-platform --local -c "$CFG" --persist-to "$WORK/state"
step "2 dry run (read+transform)"   node scripts/cf/migrate-store-to-do.mjs --all --dry-run
step "3 platform -> D1"             node scripts/cf/migrate-platform-to-d1.mjs "${D1[@]}" --archive-dir "$WORK/analytics"
step "4 stores -> StoreDO (all)"    node scripts/cf/migrate-store-to-do.mjs --all --batch rehearsal-1 --report "$WORK/migrate-1.json"
step "5 verify (all stores + D1)"   node scripts/cf/verify-store.mjs --all "${D1[@]}" --report "$WORK/verify-1.json"
step "6 re-run same batch (no-op)"  node scripts/cf/migrate-store-to-do.mjs --all --batch rehearsal-1
step "7 re-run new batch (upsert)"  node scripts/cf/migrate-store-to-do.mjs --all --batch rehearsal-2
step "8 verify again"               node scripts/cf/verify-store.mjs --all "${D1[@]}" --report "$WORK/verify-8.json"
# Flag flip: stores.storage_backend ships in the generated D1 schema (step 1), no stand-in column needed.
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

# a live-side value Postgres has no column for (customers.buyer_key, a Cloudflare-only addition, Ruling CF-SCHEMA-*) cannot be
# carried back: refuse + roll the replay back. (orders.buyer_key HAS a Postgres column since the WhatsApp contract.)
BK=$(printf "ab%.0s" $(seq 1 32))  # 64 hex chars
dosql "$SID" "INSERT INTO customers (id, store_id, first_name, last_name, buyer_key) VALUES ('live-cust-1', '$SID', 'Live', 'Buyer', '$BK')"
expect_fail "16 rollback, unreplayable data" "replay FAILED and was rolled back" node scripts/cf/flip-backend.mjs --to pg --all "${D1[@]}" --replay-pg-url "$CUTOVER_PG_URL" --yes
[ "$(pgq "select md5(string_agg(name, ',' order by id)) from categories where store_id = '$SID'")" = "$BEFORE" ] || { echo "BUG: failed replay left rows in postgres"; exit 1; }
dosql "$SID" "DELETE FROM customers WHERE id = 'live-cust-1'"

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
V1=$(tail -1 "$WORK/5 verify (all stores + D1).log"); V2=$(tail -1 "$WORK/8 verify again.log"); V3=$(tail -1 "$WORK/21 verify the retry.log")
for v in "$V1" "$V2" "$V3"; do case "$v" in *": PASS") ;; *) echo "BUG: a verify did not end PASS: $v"; exit 1;; esac; done
echo; echo "verify: $V1"; echo "verify after re-runs: $V2"; echo "verify after reset + re-import: $V3"
echo; printf '%s\n' "${ROWS[@]}"; echo "workdir: $WORK"
echo; echo "REHEARSAL PASS dump=$(basename "$DUMP") steps=${#ROWS[@]} wall=$(( SECONDS - T_ALL ))s verify='${V3%%in *}' (local workerd + scratch restore only; production untouched)"
