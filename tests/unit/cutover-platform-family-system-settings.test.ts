/**
 * Blocker B1 of the final review: the `platform` family copy removes D1 rows Postgres does not have (step 3b "strays") and
 * verifies `system_settings` with `verifyWhere`. D1 also holds bookkeeping Postgres never has: every family's marker and freeze,
 * the customer-auth markers (per store and `.__all`), and anything written with `category = 'cutover'`. If the predicate
 * matched those, `--commit` would delete them (flipping every DO store's customers back to Postgres).
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  SYSTEM_SETTINGS_DATA_WHERE,
  verifyWhere,
} from '../../scripts/cf/cutover-platform-family.mjs';

const STORE = '11111111-1111-4111-8111-111111111111';
const BOOKKEEPING = [
  ['platform_cutover.billing', 'cutover'],
  ['platform_cutover.platform', 'cutover'],
  ['platform_freeze.platform', 'cutover'],
  ['platform_cutover.analytics', 'cutover'],
  [`customer_auth_cutover.${STORE}`, 'cutover'],
  ['customer_auth_cutover.__all', 'cutover'],
  [`customer_auth_freeze.${STORE}`, 'cutover'],
  ['customer_auth_freeze.__any', 'cutover'],
  ['some_future_cutover.x', 'cutover'],
  ['uncategorised_marker_cutover.y', 'general'], // the key shape alone is enough
];
const COPIED = [
  ['ebda.vat', 'general'],
  ['site.name', 'general'],
];

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(
    'CREATE TABLE system_settings (id TEXT PRIMARY KEY, key TEXT UNIQUE, value TEXT, category TEXT, is_public INTEGER)'
  );
  [...BOOKKEEPING, ...COPIED].forEach(([key, category], i) =>
    d
      .prepare('INSERT INTO system_settings VALUES (?, ?, ?, ?, 0)')
      .run(`r${i}`, key, '{}', category)
  );
  return d;
}

describe('platform family: system_settings strays and verify never see D1-only bookkeeping', () => {
  it('the predicate selects only the settings Postgres owns', () => {
    const rows = db()
      .prepare(`SELECT key FROM system_settings${verifyWhere('system_settings')}`)
      .all() as Array<{ key: string }>;
    expect(rows.map(r => r.key).sort()).toEqual(COPIED.map(c => c[0]).sort());
  });

  it('the stray delete (every row of that predicate Postgres did not copy) leaves every marker and freeze in place', () => {
    const d = db();
    // Postgres has `site.name` only: `ebda.vat` is a genuine stray, every marker is NOT (it is outside the predicate)
    const copied = new Set(['site.name']);
    const have = d
      .prepare(`SELECT key FROM system_settings${verifyWhere('system_settings')}`)
      .all() as Array<{ key: string }>;
    for (const r of have.filter(r => !copied.has(r.key)))
      d.prepare('DELETE FROM system_settings WHERE key = ?').run(r.key);
    const left = (d.prepare('SELECT key FROM system_settings').all() as Array<{ key: string }>).map(
      r => r.key
    );
    for (const [key] of BOOKKEEPING) expect(left, key).toContain(key);
    expect(left).not.toContain('ebda.vat');
  });

  it('other tables keep their own predicates', () => {
    expect(verifyWhere('plans')).toBe('');
    expect(SYSTEM_SETTINGS_DATA_WHERE).toContain('customer_auth_%');
  });
});
