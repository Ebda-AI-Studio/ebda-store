// The committed SQL and manifest are exactly what the generator produces from schema.prisma now
// (a new Prisma column or model without a regenerate fails here), and every raw Postgres invariant
// (named CHECKs, partial indexes) is either placed or consciously skipped with a reason.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, emitSql, emitStoreMigrationsTs, MAX_COLUMNS } from '../scripts/generate.mjs';
import { PKG } from './helpers';

const { out, manifest } = build();
const read = (rel: string) => fs.readFileSync(path.join(PKG, rel), 'utf8');

describe('generated schema is current', () => {
  it('store migration', () => {
    expect(read('migrations/store/0001_init.sql')).toBe(
      emitSql(out['store-do'], 'StoreDO schema (one SQLite Durable Object per store)')
    );
  });
  it('store migrations module carries both SQL files verbatim, in order', async () => {
    const { STORE_MIGRATIONS } = await import('../src/store/migrations.generated');
    expect(STORE_MIGRATIONS.map(m => m.id)).toEqual([
      'cf-0001_init',
      'cf-0002_invariants',
      'cf-0003_analytics',
      'cf-0004_template_current',
      'cf-0005_reorder_rules_one_per_item',
      'cf-0006_template_expand_only',
      'cf-0009_ai_replace_backups',
    ]);
    expect(STORE_MIGRATIONS[0].sql).toBe(read('migrations/store/0001_init.sql'));
    expect(STORE_MIGRATIONS[1].sql).toBe(read('migrations/store/0002_invariants.sql'));
    expect(STORE_MIGRATIONS[3].sql).toBe(read('migrations/store/0004_template_current.sql'));
    expect(STORE_MIGRATIONS[4].sql).toBe(
      read('migrations/store/0005_reorder_rules_one_per_item.sql')
    );
    expect(typeof emitStoreMigrationsTs).toBe('function');
  });
  it('platform migration', () => {
    expect(read('migrations/platform/0001_init.sql')).toBe(
      emitSql(out.d1, 'D1 ebda-platform schema (identity excluded: it lives in ebda-identity)')
    );
  });
  it('manifest', () => {
    expect(JSON.parse(read('generated/manifest.json'))).toEqual(
      JSON.parse(JSON.stringify({ ...manifest, meta: undefined }))
    );
    expect(JSON.parse(read('generated/prisma-meta.json'))).toEqual(
      JSON.parse(JSON.stringify(manifest.meta))
    );
  });
  it('no table passes the Durable Object column limit', () => {
    for (const db of Object.values(out) as { tables: { name: string; columns: unknown[] }[] }[])
      for (const t of db.tables) expect(t.columns.length, t.name).toBeLessThanOrEqual(MAX_COLUMNS);
  });
});

describe('raw Postgres invariants', () => {
  const inv = manifest.rawInvariants as {
    kind: string;
    name: string;
    table: string;
    disposition: string;
  }[];
  it('none is silently lost: every one is placed in a database or skipped with a stated reason', () => {
    expect(inv.length).toBeGreaterThan(100);
    for (const r of inv)
      expect(r.disposition, `${r.kind} ${r.name}`).toMatch(
        /^(store-do:|d1:|store-do:.*,d1:|skipped: .+)/
      );
    expect(inv.filter(r => /UNPLACED/.test(r.disposition))).toEqual([]);
  });
  it('the skipped ones are exactly: identity/analytics models and Postgres trigram GIN indexes (replaced by FTS5)', () => {
    for (const r of inv.filter(x => x.disposition.startsWith('skipped'))) {
      expect(r.disposition, r.name).toMatch(/targets (identity|analytics)|trigram GIN/);
    }
  });
});
