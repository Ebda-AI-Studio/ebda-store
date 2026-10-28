// D1 side of the rollback guard: a per-row baseline of the platform database taken at the flip, and the
// diff of the live database against it (Audit DB-1). Mirrors the StoreDO __seal/__diff.
import {
  PK_SEP,
  canonRow,
  canonValue,
  sha256Hex,
} from '../../../packages/cf-migrate/src/canon.mjs';
import { d1QueryMany, d1Statements, lit } from './d1.mjs';

const q = s => `"${s}"`;
const select = t =>
  `SELECT ${t.columns.map(c => q(c.col)).join(', ')} FROM ${q(t.name)} ORDER BY ${t.pk.map(q).join(', ')}`;

async function snapshot(d, tables) {
  const res = await d1QueryMany(d, tables.map(select));
  const out = new Map();
  for (const [i, t] of tables.entries()) {
    const names = t.columns.map(c => c.col);
    const m = new Map();
    for (const r of res[i]) {
      const values = names.map(c => r[c]);
      const key = t.pk.map(k => canonValue(r[k])).join(PK_SEP);
      m.set(key, { hash: await sha256Hex(canonRow(names, values)), values });
    }
    out.set(t.name, m);
  }
  return out;
}

export async function writeBaseline(d, tables) {
  const snap = await snapshot(d, tables);
  const stmts = [
    'CREATE TABLE IF NOT EXISTS cf_seal_baseline (tbl TEXT NOT NULL, pk TEXT NOT NULL, rowhash TEXT NOT NULL, PRIMARY KEY (tbl, pk));',
    'DELETE FROM cf_seal_baseline;',
  ];
  let n = 0;
  for (const [tbl, m] of snap)
    for (const [pk, { hash }] of m) {
      stmts.push(
        `INSERT INTO cf_seal_baseline (tbl, pk, rowhash) VALUES (${lit(tbl)}, ${lit(pk)}, ${lit(hash)});`
      );
      n++;
    }
  await d1Statements(d, stmts);
  return n;
}

/** same shape as the StoreDO __diff tables entry, per platform table */
export async function diffAgainstBaseline(d, tables) {
  const have = await d1QueryMany(d, [
    `SELECT name FROM sqlite_master WHERE name = 'cf_seal_baseline'`,
  ]);
  if (!have[0].length)
    throw new Error(
      'D1 has no cf_seal_baseline: the flip to the Cloudflare side did not record one'
    );
  const [base] = await d1QueryMany(d, ['SELECT tbl, pk, rowhash FROM cf_seal_baseline']);
  const baseBy = new Map();
  for (const r of base) {
    if (!baseBy.has(r.tbl)) baseBy.set(r.tbl, new Map());
    baseBy.get(r.tbl).set(r.pk, r.rowhash);
  }
  const snap = await snapshot(d, tables);
  const out = {};
  for (const t of tables) {
    const b = baseBy.get(t.name) ?? new Map();
    const cur = snap.get(t.name);
    const added = [];
    const changed = [];
    for (const [key, { hash, values }] of cur) {
      if (!b.has(key)) added.push(values);
      else if (b.get(key) !== hash) changed.push(values);
    }
    const deleted = [...b.keys()].filter(k => !cur.has(k)).map(k => k.split(PK_SEP));
    if (added.length + changed.length + deleted.length)
      out[t.name] = { columns: t.columns.map(c => c.col), pk: t.pk, added, changed, deleted };
  }
  return out;
}
