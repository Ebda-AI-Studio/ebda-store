// Task 1.4: every Store column is assigned exactly once; no emitted table passes 100 columns.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSchema } from '../scripts/prisma-parse.mjs';
import {
  classifyStoreColumns,
  STORE_D1_ONLY,
  STORE_MIRROR,
  STORE_PROFILE,
} from '../scripts/store-split.mjs';
import { openDb, readJson, REPO } from './helpers';

const schema = parseSchema(
  fs.readFileSync(path.join(REPO, 'packages/database/prisma/schema.prisma'), 'utf8')
);
const store = schema.models.find(m => m.name === 'Store')!;
const scalars = store.fields.filter(f => f.kind !== 'relation').map(f => f.name);

describe('Store split', () => {
  it('assigns every Store scalar to exactly one bucket and names no column that does not exist', () => {
    const b = classifyStoreColumns(scalars) as Record<string, string[]>;
    const all = [...b.d1Only, ...b.mirror, ...b.profile, ...b.config];
    expect(all.sort()).toEqual([...scalars].sort());
    expect(new Set(all).size).toBe(scalars.length);
    expect(scalars.length).toBe(97); // pinned: a new Store column must be placed consciously (97 = 95 + ci_sharing + ci_sharing_changed_at, CI-1)
    for (const n of [...STORE_D1_ONLY, ...STORE_MIRROR, ...STORE_PROFILE])
      expect(scalars, n).toContain(n);
  });

  it('rejects a column listed in two buckets (mutation: the classifier throws)', () => {
    expect(() => classifyStoreColumns([...scalars])).not.toThrow();
    const dup = STORE_PROFILE[0];
    STORE_D1_ONLY.push(dup);
    try {
      expect(() => classifyStoreColumns(scalars)).toThrow(/more than one bucket/);
    } finally {
      STORE_D1_ONLY.pop();
    }
  });

  it('the D1 directory holds d1Only + mirror; the DO holds mirror in store_profile; none exceeds 100 columns', () => {
    const manifest = readJson<{
      databases: Record<string, { columnCounts: Record<string, number>; maxColumns: number }>;
    }>('generated/manifest.json');
    const b = classifyStoreColumns(scalars) as Record<string, string[]>;
    expect(manifest.databases.d1.columnCounts.stores).toBe(b.d1Only.length + b.mirror.length + 2); // + storage_backend, template_original (CF-only)
    expect(manifest.databases['store-do'].columnCounts.store_profile).toBe(
      1 + b.mirror.length - 1 + b.profile.length
    ); // id becomes store_id
    expect(manifest.databases['store-do'].columnCounts.store_config).toBe(1 + b.config.length);
    for (const db of Object.values(manifest.databases)) {
      for (const [t, n] of Object.entries(db.columnCounts)) expect(n, t).toBeLessThanOrEqual(100);
    }
  });

  it('unique directory keys are enforced in D1 only (a duplicate slug or domain is refused)', () => {
    const d1 = openDb('platform');
    const ins = d1.prepare(
      `INSERT INTO stores (id, name, slug, domain, owner_id, status, plan, currency, timezone, template, is_demo) VALUES (?, 'n', ?, ?, 'o', 'active', 'free', 'EGP', 'Africa/Cairo', 'qamar', 0)`
    );
    ins.run('s1', 'one', 'one.example.com');
    expect(() => ins.run('s2', 'one', null)).toThrow(/UNIQUE/);
    expect(() => ins.run('s3', 'three', 'one.example.com')).toThrow(/UNIQUE/);
  });
});
