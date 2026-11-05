// Ruling CUTOVER-5: the cutover knows what to do with EVERY table. A table that exists in the generated
// Cloudflare schema (StoreDO or D1) or that the StoreDO creates at run time must have (1) a migrate mapping
// (a Postgres twin the plan reads, a CF-only rule verify checks, or a runtime-table entry) and (2) an erasure
// classification. Adding a table without both fails here, not at 03:00 in the window.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CF_ONLY_TABLES,
  DO_RUNTIME_TABLES,
  acceptableDigests,
  knownDoTable,
} from '../src/coverage.mjs';
import { loadPlan } from '../../../scripts/cf/lib/plan.mjs';
import { storeDo } from './helpers';
import { handleStoreAdmin } from '../src/store-admin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const schema = path.join(repo, 'packages/cf-schema');

function tablesOf(target: 'store' | 'platform'): string[] {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_invariants.sql'])
    db.exec(fs.readFileSync(path.join(schema, 'migrations', target, f), 'utf8'));
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
  ).map(r => r.name);
}

const classification = JSON.parse(
  fs.readFileSync(path.join(schema, 'erasure-classification.json'), 'utf8')
) as Record<string, { class: string; action: string }>;
const plan = loadPlan();
const DBS = [
  { db: 'store-do', tables: tablesOf('store'), planned: plan.store },
  { db: 'd1', tables: tablesOf('platform'), planned: plan.platform },
] as const;

describe('cutover coverage: every cf-schema table', () => {
  for (const { db, tables, planned } of DBS) {
    it(`${db}: each table has a migrate mapping (Postgres source or a CF-only rule)`, () => {
      const unmapped: string[] = [];
      const byName = new Map(planned.map(t => [t.name, t]));
      for (const name of tables) {
        const t = byName.get(name);
        if (!t) unmapped.push(`${name}: in the schema but not in the migration plan`);
        else if (t.inPg) continue;
        else if (!CF_ONLY_TABLES[`${db}:${name}`])
          unmapped.push(`${name}: no Postgres table and no CF_ONLY_TABLES rule`);
      }
      expect(unmapped).toEqual([]);
    });

    it(`${db}: each table has an erasure classification`, () => {
      const missing = tables.filter(n => !classification[`${db}:${n}`]);
      expect(missing).toEqual([]);
    });
  }

  it('every CF-only rule names a real table that is really absent from Postgres', () => {
    for (const key of Object.keys(CF_ONLY_TABLES)) {
      const [db, name] = key.split(':');
      const t = (db === 'd1' ? plan.platform : plan.store).find(x => x.name === name);
      expect(t, key).toBeTruthy();
      expect(t!.inPg, `${key} now exists in Postgres: map it instead of ruling it CF-only`).toBe(
        false
      );
    }
  });

  it('every acceptable CF-only row set fits the table columns and keeps its checksum stable', async () => {
    for (const [key, rule] of Object.entries(CF_ONLY_TABLES)) {
      if (!rule.acceptable) continue;
      const [db, name] = key.split(':');
      const t = (db === 'd1' ? plan.platform : plan.store).find(x => x.name === name)!;
      for (const set of rule.acceptable)
        for (const row of set) expect(row.length, key).toBe(t.columns.length);
      const a = await acceptableDigests(t, rule);
      const b = await acceptableDigests(t, rule);
      expect(a).toEqual(b);
      expect(a.length).toBe(rule.acceptable.length);
    }
  });
});

describe('cutover coverage: tables the StoreDO creates at run time', () => {
  const generated = new Set(tablesOf('store'));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(repo, 'packages/repo/src'));

  it('every table the repo layer CREATEs is generated or a registered runtime table', () => {
    const found = new Set<string>();
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(
        /CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS\s+"?([a-z_][a-z0-9_]*)/gi
      ))
        found.add(m[1]);
      for (const m of text.matchAll(/const TABLE = '([a-z_][a-z0-9_]*)'/g)) found.add(m[1]);
    }
    expect(found.size).toBeGreaterThan(3); // the scan itself works
    const planNames = new Set(plan.store.map(t => t.name));
    const unknown = [...found].filter(n => !generated.has(n) && !knownDoTable(n, planNames));
    expect(unknown).toEqual([]);
  });

  it('every runtime table has an erasure answer, and none shadows a migrated table', () => {
    const planNames = new Set(plan.store.map(t => t.name));
    for (const [n, r] of Object.entries(DO_RUNTIME_TABLES)) {
      expect(['ttl', 'derived', 'no-pii'], n).toContain(r.erasure);
      if (planNames.has(n)) expect(classification[`store-do:${n}`], n).toBeTruthy();
    }
  });
});

describe('cutover coverage: the DO reports its tables', () => {
  it('__tables lists every application table, all of them known to the cutover', async () => {
    const { sql, transactionSync } = storeDo();
    const res = await handleStoreAdmin(new Request('http://x/cutover/stores/s/__tables'), {
      sql,
      transactionSync,
    });
    const j = (await res.json()) as { ok: boolean; tables: string[] };
    expect(j.ok).toBe(true);
    const planNames = new Set(plan.store.map(t => t.name));
    expect(j.tables.filter(n => !knownDoTable(n, planNames))).toEqual([]);
    expect(j.tables).toContain('orders');
  });
});
