// Erasing a user nulls the confirming/acting user id on the D1 platform schema (twin of the Postgres scrub).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { nodeSyncSql } from './node-sync-sql';
import { PLATFORM_USER_SCRUB, scrubUserFromPlatform } from '../src/platform-erasure';

const CF = path.resolve(__dirname, '../../cf-schema');
function platformDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const dir = path.join(CF, 'migrations/platform');
  for (const f of fs
    .readdirSync(dir)
    .filter(x => x.endsWith('.sql'))
    .sort())
    raw.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  return raw;
}

describe('platform user erasure', () => {
  it('nulls verified_by_id and actor_id for the erased user only, and keeps the verification', () => {
    const raw = platformDb();
    raw.exec(`INSERT INTO provider_verifications (provider, kind, verified_at, verified_by_id) VALUES
      ('paymob', 'payment', 1000, 'u1'), ('kashier', 'payment', 2000, 'u2')`);
    raw.exec(
      `INSERT INTO platform_audit_log (id, actor_id, action) VALUES ('a1', 'u1', 'x'), ('a2', 'u2', 'x')`
    );
    const r = scrubUserFromPlatform(nodeSyncSql(raw), 'u1');
    expect(r.rows).toBe(2);
    const pv = raw
      .prepare(
        `SELECT provider, verified_at, verified_by_id FROM provider_verifications ORDER BY provider`
      )
      .all();
    expect(pv).toEqual([
      { provider: 'kashier', verified_at: 2000, verified_by_id: 'u2' },
      { provider: 'paymob', verified_at: 1000, verified_by_id: null },
    ]);
    expect(raw.prepare(`SELECT id, actor_id FROM platform_audit_log ORDER BY id`).all()).toEqual([
      { id: 'a1', actor_id: null },
      { id: 'a2', actor_id: 'u2' },
    ]);
  });

  it('handles exactly the d1 columns the erasure classification scrubs by userId (a new one fails here)', () => {
    const cls = JSON.parse(
      fs.readFileSync(path.join(CF, 'erasure-classification.json'), 'utf8')
    ) as Record<
      string,
      { db: string; action: string; piiColumns: string[]; subjectKeys: string[] }
    >;
    const expected: Record<string, string[]> = {};
    for (const [key, e] of Object.entries(cls))
      if (e.db === 'd1' && e.action === 'scrub' && e.subjectKeys.includes('userId'))
        expected[key.replace(/^d1:/, '')] = [...e.piiColumns].sort();
    const actual = Object.fromEntries(
      Object.entries(PLATFORM_USER_SCRUB).map(([t, c]) => [t, [...c].sort()])
    );
    expect(actual).toEqual(expected);
    // classification must name real columns
    const raw = platformDb();
    for (const [t, cols] of Object.entries(expected))
      for (const c of cols)
        expect(
          (raw.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(x => x.name),
          `${t}.${c}`
        ).toContain(c);
  });
});
