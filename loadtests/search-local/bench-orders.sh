#!/usr/bin/env bash
# LOCAL ONLY (Task 14): N parallel single-worker processes of bench-orders.ts, merged.
#   bash loadtests/search-local/bench-orders.sh <slug> <workers> <seconds> [.old]
set -uo pipefail
cd "$(dirname "$0")/../.."
SLUG=${1:-load-20000}; N=${2:-8}; SECS=${3:-20}; SUF=${4:-}
OUT=$(mktemp -d)
for i in $(seq 1 "$N"); do
  BENCH_OUT=$OUT/$i.json npx tsx loadtests/search-local/bench-orders.ts "$SLUG" 1 "$SECS" "$SUF" >/dev/null 2>&1 &
done
wait
python3 - "$OUT" "$N" "$SECS" <<'PY'
import json,sys,glob
d,n,secs=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
lat={'list':[],'customers':[]}
for f in glob.glob(d+'/*.json'):
    j=json.load(open(f))
    for k in lat: lat[k]+=j[k]
q=lambda a,p: sorted(a)[min(len(a)-1,int(p*len(a)))] if a else 0
for k,a in lat.items(): print(f"{k:10} n={len(a)} p50={q(a,.5):.0f} p95={q(a,.95):.0f} p99={q(a,.99):.0f} max={max(a) if a else 0:.0f} ms")
print(f"throughput {(len(lat['list'])+len(lat['customers']))/secs:.0f} req/s with {n} workers")
PY
rm -rf "$OUT"
