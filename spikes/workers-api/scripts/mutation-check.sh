#!/usr/bin/env bash
# Mutation check: break the per-request GUC handling, expect the isolation tests to go RED, then restore.
set -uo pipefail
cd "$(dirname "$0")/.."
F=src/db.ts; BAK=$(mktemp); cp $F $BAK
restore() { cp $BAK $F; rm -f $BAK; bash scripts/pooler.sh stop >/dev/null 2>&1; bash scripts/pooler.sh start >/dev/null 2>&1; }
trap restore EXIT
mkdir -p results
run() { # name, outfile
  bash scripts/pooler.sh stop >/dev/null 2>&1; bash scripts/pooler.sh start >/dev/null 2>&1   # drop any leaked session state
  npx vitest run test/isolation.test.ts test/routes.test.ts --reporter=verbose > "results/$1.txt" 2>&1; local rc=$?
  echo "== $1: vitest exit=$rc"; grep -E "^ +(×|✗)|FAIL " "results/$1.txt" | sed 's/ [0-9]*ms$//' | sort -u; grep -E "Tests +[0-9]" "results/$1.txt"
}
echo "== baseline"; run baseline
echo; echo "== mutation 1: set_config(..., true) -> set_config(..., false)  (session-level GUC)"
sed -i "s/\${g.storeId}, true)/\${g.storeId}, false)/; s/\${g.userId}, true)/\${g.userId}, false)/" $F
grep -n "set_config" $F | grep -v '^\s*//' | grep -E "false" ; run mutation1-session-level
cp $BAK $F
echo; echo "== mutation 2: store-id set_config call removed entirely"
sed -i "s|    await tx.\$queryRaw\`SELECT set_config('app.current_store_id', \${g.storeId}, true)\`;|    // MUTATION: store GUC not set|" $F
grep -n "MUTATION" $F; run mutation2-no-set-config
cp $BAK $F
echo; echo "== restored"; diff -q $BAK $F && echo "src/db.ts identical to original"
run restored
