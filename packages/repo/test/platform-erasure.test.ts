// OFFBOARD-1: erasing a user clears their id from every actor column the classification names, on the D1 platform
// schema and on a StoreDO schema, and leaves other users' ids and the facts themselves alone.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { nodeSyncSql } from './node-sync-sql';
import {
  actorScrubPlan,
  scrubUserFromPlatform,
  scrubUserFromStoreDo,
} from '../src/platform-erasure';
import { openSqlite } from './diff-harness';
import { ensureSmartLayerSchema } from '../src/do/smart-layer';

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

describe('actor-id erasure', () => {
  it('D1: nulls verified_by_id / actor_id / reviewed_by for the erased user only, keeps the facts, tombstones a NOT NULL column', () => {
    const raw = platformDb();
    raw.exec('PRAGMA foreign_keys = OFF'); // fixtures name stores that are not seeded
    raw.exec(`INSERT INTO provider_verifications (provider, kind, verified_at, verified_by_id) VALUES
      ('paymob', 'payment', 1000, 'u1'), ('kashier', 'payment', 2000, 'u2')`);
    raw.exec(
      `INSERT INTO platform_audit_log (id, actor_id, action) VALUES ('a1', 'u1', 'x'), ('a2', 'u2', 'x')`
    );
    raw.exec(
      `INSERT INTO store_features (id, store_id, feature_key, enabled, enabled_by) VALUES ('f1', 's1', 'f', 1, 'u1'), ('f2', 's1', 'g', 1, 'u2')`
    );
    const r = scrubUserFromPlatform(nodeSyncSql(raw), 'u1');
    expect(r.rows).toBe(3);
    expect(
      raw
        .prepare(
          `SELECT provider, verified_at, verified_by_id FROM provider_verifications ORDER BY provider`
        )
        .all()
    ).toEqual([
      { provider: 'kashier', verified_at: 2000, verified_by_id: 'u2' },
      { provider: 'paymob', verified_at: 1000, verified_by_id: null },
    ]);
    expect(raw.prepare(`SELECT id, actor_id FROM platform_audit_log ORDER BY id`).all()).toEqual([
      { id: 'a1', actor_id: null },
      { id: 'a2', actor_id: 'u2' },
    ]);
    expect(
      raw.prepare(`SELECT feature_key, enabled_by FROM store_features ORDER BY feature_key`).all()
    ).toEqual([
      { feature_key: 'f', enabled_by: null },
      { feature_key: 'g', enabled_by: 'u2' },
    ]);
  });

  it('StoreDO: nulls created_by / approved_by / actor_id for the erased user only', () => {
    const raw = openSqlite();
    const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
    x(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p', 's1', 'W', 'w', 100, 5, 'active')`
    );
    x(`INSERT INTO inventory_history (id, store_id, product_id, type, quantity, previous_stock, new_stock, created_by) VALUES
      ('h1', 's1', 'p', 'adjustment', 1, 5, 6, 'u1'), ('h2', 's1', 'p', 'adjustment', 1, 6, 7, 'u2')`);
    const r = scrubUserFromStoreDo(nodeSyncSql(raw), 'u1');
    expect(r.rows).toBeGreaterThanOrEqual(1);
    expect(raw.prepare(`SELECT id, created_by FROM inventory_history ORDER BY id`).all()).toEqual([
      { id: 'h1', created_by: null },
      { id: 'h2', created_by: 'u2' },
    ]);
  });

  it('StoreDO: the assistant journal rows of the erased user go with them, other users keep theirs', () => {
    const raw = openSqlite();
    const db = nodeSyncSql(raw);
    ensureSmartLayerSchema(db);
    for (const u of ['u1', 'u2']) {
      raw
        .prepare(
          "INSERT INTO sl_turns (id, store_id, thread_id, user_id, role, masked_text, at, release_id) VALUES (?, 's1', 'c', ?, 'merchant', 'x', 1, 'r')"
        )
        .run(`t-${u}`, u);
      raw
        .prepare(
          "INSERT INTO sl_audit (id, store_id, user_id, at, json) VALUES (?, 's1', ?, 1, '{}')"
        )
        .run(`a-${u}`, u);
      raw
        .prepare(
          "INSERT INTO sl_decisions (approval_id, store_id, decider, decision, at) VALUES ('ap', 's1', ?, 'confirmed', 1)"
        )
        .run(u);
    }
    scrubUserFromStoreDo(db, 'u1');
    expect(raw.prepare('SELECT id FROM sl_turns').all()).toEqual([{ id: 't-u2' }]);
    expect(raw.prepare('SELECT id FROM sl_audit').all()).toEqual([{ id: 'a-u2' }]);
    expect(raw.prepare('SELECT decider FROM sl_decisions').all()).toEqual([{ decider: 'u2' }]);
  });

  it('the plan covers every classified actor column of both databases (no hand list to drift)', () => {
    const cls = JSON.parse(
      fs.readFileSync(path.join(CF, 'erasure-classification.json'), 'utf8')
    ) as Record<string, { db: string; actorScrub?: Record<string, unknown> }>;
    for (const db of ['store-do', 'd1'] as const) {
      const expected = Object.fromEntries(
        Object.entries(cls)
          .filter(([, e]) => e.db === db && e.actorScrub)
          .map(([k, e]) => [k.split(':')[1], Object.keys(e.actorScrub!).sort()])
      );
      const actual = Object.fromEntries(
        Object.entries(actorScrubPlan(db)).map(([t, c]) => [t, Object.keys(c).sort()])
      );
      expect(actual).toEqual(expected);
      expect(Object.keys(actual).length).toBeGreaterThan(5);
    }
  });
});
