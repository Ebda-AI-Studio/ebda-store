/**
 * G18: a bulk AI run shows its cost against the store's remaining AI quota BEFORE it starts, from a read-only
 * endpoint, and is refused up front when it cannot fit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ platformToday: 0, platformMonth: 0, storeToday: 0 }));

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  assertStoreAiEnabled: async () => undefined,
}));
vi.mock('@ebda/database', () => ({
  prisma: { aiUsage: { count: async () => h.storeToday } },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  countAiUsage: async ({ since }: { since: Date }) =>
    since.getUTCDate() === 1 && since.getUTCHours() === 0 && h.platformMonth >= 0
      ? // the month window starts on day 1; the day window starts today (equal on the 1st, so key off call order below)
        h.platformMonth
      : h.platformToday,
}));

import { getAiQuotaRemaining } from '../../apps/api/src/lib/ai-quota';
import { estimateBulkAiRequests, isBulkAiKind } from '../../apps/api/src/lib/ai-bulk-estimate';

beforeEach(() => {
  h.platformToday = 0;
  h.platformMonth = 0;
  h.storeToday = 0;
  delete process.env.AI_DAILY_REQUEST_CAP;
  process.env.AI_STORE_DAILY_REQUEST_CAP = '150';
  process.env.AI_MONTHLY_REQUEST_CAP = '20000';
  process.env.AI_DAILY_REQUEST_CAP = '450';
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
  it('is the tightest of the store slice, the global bulk ceiling and the month', async () => {
    h.storeToday = 100; // store slice: 150 - 100 = 50
    h.platformToday = 0; // bulk ceiling 450 - 20% reserve = 360
    const r = await getAiQuotaRemaining('s1');
    expect(r.remaining).toBe(50);
    expect(r.limitedBy).toBe('store_daily');
  });

  it('a 200-product run does not fit a fresh store (150/day) and says so', async () => {
    const r = await getAiQuotaRemaining('s1');
    const requests = estimateBulkAiRequests('tags', 200);
    expect(requests).toBeGreaterThan(r.remaining);
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
    const tr = src.slice(src.indexOf('async function startTranslate('));
    expect(tr.indexOf('confirmEstimate(')).toBeLessThan(tr.indexOf('apiPost'));
  });
});
