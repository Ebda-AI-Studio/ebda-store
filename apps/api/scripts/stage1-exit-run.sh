#!/usr/bin/env bash
# Runs the SP4 Stage 1 exit test end to end, each run against a FRESH `wrangler dev` (cold isolate,
# empty in-memory state): pooler up, two tenants seeded, wrangler dev started, 200 concurrent mixed
# requests, wrangler stopped.
#
#   bash apps/api/scripts/stage1-exit-run.sh [runs=3] [concurrency=200]
#
# Needs: local Postgres with the migrated `ebda_s1` database (see docs/ebda/design/stage1-exit-test.md),
# pgbouncer, apps/api/.dev.vars (copy .dev.vars.example). Run as root (su postgres) or as a user
# that can run psql against ebda_s1 as the DB owner.
#
# Why one fresh wrangler per run: `wrangler dev` runs the Worker in a local workerd with no isolate
# memory limit and its proxy worker dies under back-to-back 200-way bursts once the heap has grown
# (see the "Findings" section of the doc). A burst against a fresh dev server is the cold-start case
# the exit test is about.
set -euo pipefail
RUNS="${1:-3}"
N="${2:-200}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT_DIR:-${TMPDIR:-/tmp}/stage1-exit}"
PORT=8799
mkdir -p "$OUT"
cd "$HERE"

bash scripts/cf-pooler.sh start
if [ "$(id -u)" = 0 ]; then
  su postgres -c "psql -v ON_ERROR_STOP=1 -q -d ebda_s1 -f $HERE/scripts/cf-seed.sql"
else
  psql -v ON_ERROR_STOP=1 -q -d ebda_s1 -f scripts/cf-seed.sql
fi

# The API config without its Workers AI binding: that binding runs remotely and needs a login
# (scripts/cf-api-local-config.mjs, Ruling SEARCH-T10-4).
node ../../scripts/cf-api-local-config.mjs

pass=0
for i in $(seq 1 "$RUNS"); do
  echo "=== run $i / $RUNS ==="
  if curl -s -m 1 "localhost:$PORT/health" >/dev/null 2>&1; then echo "something already answers on :$PORT" >&2; exit 3; fi
  NO_PROXY=127.0.0.1,localhost setsid npx wrangler dev --port "$PORT" --local --config .wrangler.local.jsonc > "$OUT/wrangler-$i.log" 2>&1 &
  WR=$!
  for _ in $(seq 1 90); do curl -s -m 2 "localhost:$PORT/health" >/dev/null && break; sleep 2; done
  if node scripts/stage1-exit-test.mjs --rounds 1 --n "$N" --base "http://127.0.0.1:$PORT" --out "$OUT/run-$i.json"; then
    pass=$((pass + 1))
  fi
  # Stop this dev server for real before the next run starts: a leftover one still answers /health
  # and would take the next burst while it is shutting down.
  kill -TERM -- -"$WR" 2>/dev/null || kill -TERM "$WR" 2>/dev/null || true
  for _ in $(seq 1 20); do curl -s -m 1 "localhost:$PORT/health" >/dev/null 2>&1 || break; sleep 1; done
  kill -KILL -- -"$WR" 2>/dev/null || true
  for _ in $(seq 1 10); do curl -s -m 1 "localhost:$PORT/health" >/dev/null 2>&1 || break; sleep 1; done
  if curl -s -m 1 "localhost:$PORT/health" >/dev/null 2>&1; then echo "dev server on :$PORT would not stop" >&2; exit 3; fi
done
echo "$pass / $RUNS runs passed (raw results: $OUT)"
[ "$pass" = "$RUNS" ]
