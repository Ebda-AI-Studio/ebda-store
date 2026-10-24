// Compare two baseline.mjs outputs (Postgres path vs StoreDO path). Task 0.5.
//   node bench/compare.mjs results/baseline-2026-10-24.json results/do-<date>.json
// Exit 0 always; prints `p95 gate: PASS|FAIL` per endpoint. Endpoints present on only one side are listed as n/a.
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
const rows = [];
for (const name of new Set([...Object.keys(a.endpoints), ...Object.keys(b.endpoints)])) {
  const x = a.endpoints[name];
  const y = b.endpoints[name];
  const gate =
    x?.p95_ms != null && y?.p95_ms != null ? (y.p95_ms <= x.p95_ms ? 'PASS' : 'FAIL') : 'n/a';
  rows.push({
    endpoint: name,
    'pg p50/p95/p99': x ? `${x.p50_ms}/${x.p95_ms}/${x.p99_ms}` : '-',
    'do p50/p95/p99': y ? `${y.p50_ms}/${y.p95_ms}/${y.p99_ms}` : '-',
    'p95 delta ms':
      x?.p95_ms != null && y?.p95_ms != null ? +(y.p95_ms - x.p95_ms).toFixed(1) : '-',
    'p95 gate': gate,
  });
}
console.table(rows);
for (const r of rows) console.log(`${r.endpoint}: p95 gate: ${r['p95 gate']}`);
