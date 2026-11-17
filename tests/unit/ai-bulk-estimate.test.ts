/**
 * G18: a bulk AI run shows its cost against the store's remaining AI quota BEFORE it starts, from a read-only
 * endpoint, and is refused up front when it cannot fit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ platformToday: 0, platformMonth: 0, storeToday: 0 }));

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  assertStoreAiEnabled: async () => undefined,
}));
vi.mock('@ebda/database', () => ({
  prisma: { aiUsage: { count: async () => h.storeToday } },
}));
// The day window starts at 00:00 UTC today, the month window earlier (or the same instant on the 1st): tell them apart by
// whether `since` is the start of TODAY, and make the 1st of the month irrelevant by pinning the clock to the 15th.
vi.mock('../../apps/api/src/lib/definer', () => ({
  countAiUsage: async ({ since }: { since: Date }) =>
    since.getUTCDate() === new Date().getUTCDate() ? h.platformToday : h.platformMonth,
}));

import { getAiQuotaRemaining } from '../../apps/api/src/lib/ai-quota';
import { estimateBulkAiRequests, isBulkAiKind } from '../../apps/api/src/lib/ai-bulk-estimate';

const KEYS = ['AI_DAILY_REQUEST_CAP', 'AI_STORE_DAILY_REQUEST_CAP', 'AI_MONTHLY_REQUEST_CAP'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  h.platformToday = 0;
  h.platformMonth = 0;
  h.storeToday = 0;
  process.env.AI_DAILY_REQUEST_CAP = '450';
  process.env.AI_STORE_DAILY_REQUEST_CAP = '150';
  process.env.AI_MONTHLY_REQUEST_CAP = '20000';
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('estimateBulkAiRequests', () => {
  it('per-product kinds scale with the catalogue; master sweeps multiply; store-level kinds are fixed', () => {
    expect(estimateBulkAiRequests('tags', 120)).toBe(120);
    expect(estimateBulkAiRequests('aeo-sweep-all', 100)).toBe(300);
    expect(estimateBulkAiRequests('llms-txt', 5000)).toBe(1);
    expect(estimateBulkAiRequests('revert-balance', 5000)).toBe(0);
    expect(isBulkAiKind('nope')).toBe(false);
    expect(isBulkAiKind('hasOwnProperty')).toBe(false);
  });
});

describe('getAiQuotaRemaining', () => {
  it('store slice is the tightest: 150 - 100 used', async () => {
    h.storeToday = 100;
    expect(await getAiQuotaRemaining('s1')).toEqual({ remaining: 50, limitedBy: 'store_daily' });
  });

  it('global bulk ceiling is the tightest: 450 less the 20% reserve = 360, 340 used', async () => {
    h.platformToday = 340;
    expect(await getAiQuotaRemaining('s1')).toEqual({ remaining: 20, limitedBy: 'global_daily' });
  });

  it('the month is the tightest: 20000 cap, 19990 used', async () => {
    h.platformMonth = 19990;
    expect(await getAiQuotaRemaining('s1')).toEqual({ remaining: 10, limitedBy: 'monthly' });
  });

  it('never negative once a cap is passed, and never reports platform-wide counters', async () => {
    h.storeToday = 400;
    const r = await getAiQuotaRemaining('s1');
    expect(r.remaining).toBe(0);
    expect(Object.keys(r).sort()).toEqual(['limitedBy', 'remaining']);
  });

  it('a 200-product run exceeds a fresh store (150/day): advisory, remaining stays 150', async () => {
    const r = await getAiQuotaRemaining('s1');
    expect(estimateBulkAiRequests('tags', 200)).toBeGreaterThan(r.remaining);
    expect(r.remaining).toBe(150);
  });
});

describe('wiring (source contract)', () => {
  const root = path.resolve(__dirname, '../..');
  it('the estimate route is registered before /bulk/:jobId and is a GET', () => {
    const src = fs.readFileSync(path.join(root, 'apps/api/src/routes/ai.routes.ts'), 'utf8');
    const est = src.indexOf("router.get('/bulk/estimate'");
    const job = src.indexOf("router.get('/bulk/:jobId'");
    expect(est).toBeGreaterThan(-1);
    expect(est).toBeLessThan(job);
  });
  it('the AI tools page asks for the estimate before it posts a run', () => {
    const src = fs.readFileSync(
      path.join(root, 'apps/admin/src/app/stores/[id]/ai-tools/page.tsx'),
      'utf8'
    );
    const startFn = src.slice(src.indexOf('async function start('));
    expect(startFn.indexOf('confirmEstimate(')).toBeGreaterThan(-1);
    expect(startFn.indexOf('confirmEstimate(')).toBeLessThan(startFn.indexOf('apiPost'));
    // translate is a catalogue tool now (endpoint /bulk/translate): it goes through the same start()
    expect(src).not.toContain('async function startTranslate(');
  });
  it('the page hard-stops only on canStart, never on an over-estimate (fits is advisory)', () => {
    const src = fs.readFileSync(
      path.join(root, 'apps/admin/src/app/stores/[id]/ai-tools/page.tsx'),
      'utf8'
    );
    const fn = src.slice(
      src.indexOf('async function confirmEstimate('),
      src.indexOf('async function start(')
    );
    expect(fn).toContain('!data.canStart');
    expect(fn).toContain('data.fits');
    expect(fn).not.toMatch(/!data\.(allowed|fits)\)\s*\{[^}]*return false/);
  });
  it('the route answers canStart/fits and reads only this store (no platform counters)', () => {
    const src = fs.readFileSync(path.join(root, 'apps/api/src/routes/ai.routes.ts'), 'utf8');
    const route = src.slice(
      src.indexOf("router.get('/bulk/estimate'"),
      src.indexOf("router.get('/bulk/:jobId'")
    );
    expect(route).toContain('canStart: aiEnabled && quota.remaining > 0');
    expect(route).toContain('fits: requests <= quota.remaining');
    expect(route).not.toContain('globalDaily');
  });
});
