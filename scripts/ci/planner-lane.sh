#!/usr/bin/env bash
# The SERIAL lane for planner / index tests (Ruling ITEST-13).
#
# A planner test asserts that a query used an index (`pg_stat_user_indexes.idx_scan` moves) or read few rows.
# That is a claim about the planner's choice on THIS table at THIS moment, and the choice flips when other test
# files insert into the same big tables (products, orders, users) or autovacuum runs mid-file: counters stayed
# put ("index orders_guest_email_trgm_idx was not scanned") and a store read 19,558 rows instead of < 3,000, in
# 1 of 3 full local runs, always in a different file. Per-file schemas are not an option (RLS, the ebda_* definer
# functions and the policies all live in `public`), and forcing the planner (`enable_seqscan = off`) would stop
# proving what production does. So these files run ALONE, after the parallel integration pass, on a quiet database.
#
# A planner test is, by the gate in tests/unit/planner-tests-run-as-app-role.test.ts, any file that imports
# tests/helpers/app-role-planner, so the lane is derived from that import and cannot drift from the gate.
# The same lane takes the files that count database-wide `idle in transaction` sessions (payment-outage-isolation,
# payment-scope-and-events: "the gateway is asked with NO transaction open"): every other file's open
# transaction on the shared database is a false positive for them (seen: [1] instead of [0]).
#
#   scripts/ci/planner-lane.sh list       one file per line
#   scripts/ci/planner-lane.sh excludes   "--exclude <file> ..." for the parallel pass
set -euo pipefail
cd "$(dirname "$0")/../.."
files() { grep -rlE "app-role-planner|idle in transaction" tests/integration --include='*.test.ts' | LC_ALL=C sort; }
case "${1:-list}" in
  list) files ;;
  excludes) files | sed 's/^/--exclude /' | tr '\n' ' '; echo ;;
  *) echo "usage: $0 list|excludes" >&2; exit 64 ;;
esac
