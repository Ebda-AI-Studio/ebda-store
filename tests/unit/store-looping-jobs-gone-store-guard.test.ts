/**
 * Guard for the gone-store class (billing-renewal-daily, 2026-11-11). A job that reaches a store through anything but
 * the live directory must skip a gone store (410 / 404) via the shared helper `isStoreGoneError` / `storeActiveForJob`:
 *  - cron loops over `storeDirectory` are safe by construction (the directory drops soft-deleted stores) as long as
 *    they never ask for deleted ones (`includeDeleted`);
 *  - a job that resolves a store by id (`getEntityStoreId`, `lookupStore`, `acrossBilling`) must use the helper.
 * A new store-touching job that skips both fails here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../../apps/api/src');
const dirs = ['lib/inngest/functions', 'services/billing'].map(d => join(root, d));
const files = dirs.flatMap(d =>
  readdirSync(d)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => join(d, f))
);
const usesHelper = (src: string) => /isStoreGoneError|storeActiveForJob/.test(src);
// Store-by-id resolution outside the live directory. `lookupStore` inside a helper-using job is fine; the check is per file.
const resolvesById = (src: string) =>
  /\b(getEntityStoreId|lookupStore|acrossBilling)\s*\(/.test(src) ||
  /import[^;]*\b(getEntityStoreId|lookupStore|acrossBilling)\b/.test(src);
// Files whose own helper-wrapped entry point lives elsewhere (checked below), or that never throw on a gone store.
const EXEMPT = new Set<string>([
  // account.service: per-request paths (the HTTP layer maps 404/410 to the caller), not a loop.
  'services/billing/account.service.ts',
  // webhook-delivery / r2-orphan-sweep use lookupStore as a boolean read (null = skip), never a throwing scope.
  'lib/inngest/functions/webhook-delivery.ts',
  'lib/inngest/functions/r2-orphan-sweep.ts',
  // billing-renewal.ts calls the helper-guarded service entry points (renewSubscription / sendDueReminder).
  'lib/inngest/functions/billing-renewal.ts',
  // the billing service files that CONTAIN the guarded entry points use the helper (asserted separately).
]);

describe('gone-store handling (shared helper)', () => {
  it('every job / billing file that resolves a store by id uses the helper', () => {
    const bad = files
      .map(f => ({ rel: f.slice(root.length + 1), src: readFileSync(f, 'utf8') }))
      .filter(({ rel, src }) => resolvesById(src) && !usesHelper(src) && !EXEMPT.has(rel))
      .map(x => x.rel);
    expect(bad).toEqual([]);
  });
  it('no cron loop asks the directory for deleted stores', () => {
    const bad = files
      .filter(f => !EXEMPT.has(f.slice(root.length + 1)))
      .filter(f => /includeDeleted:\s*true/.test(readFileSync(f, 'utf8')));
    expect(bad.map(f => f.slice(root.length + 1))).toEqual([]);
  });
  it('the billing entry points that the daily job calls use the helper', () => {
    for (const f of ['subscription-billing.service.ts', 'reminders.service.ts'])
      expect(usesHelper(readFileSync(join(root, 'services/billing', f), 'utf8'))).toBe(true);
  });
});
