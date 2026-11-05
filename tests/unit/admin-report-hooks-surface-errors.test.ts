// @vitest-environment jsdom
/**
 * Report-page hooks surface API errors instead of rendering them as "no data".
 *
 * 2026-09-30 analytics audit, finding 8: useAnalytics, useAbandonedCarts,
 * usePaymentAbandonments, useAnswerEngineSummary and useGscDashboard all read
 * only `data` from apiGet. A 403/500 left each widget at its initial empty
 * state (0 stats, empty table, "not connected"), indistinguishable from a
 * store that genuinely has nothing. Each hook now exposes `error` (the failed
 * call's message; `''` when it had none) and a retry; the pages render the
 * shared ErrorState / a destructive Alert from it.
 *
 * Mutation proof: drop `noteError(apiError)` from usePaymentAbandonments'
 * fetchStats → the payment-abandonments case goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@ebda/ui', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }));

const apiGet = vi.fn();
vi.mock('@admin/lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPut: vi.fn(),
}));

import { useAnalytics } from '@admin/app/stores/[id]/analytics/_hooks/useAnalytics';
import { useAbandonedCarts } from '@admin/app/stores/[id]/abandoned-carts/_hooks/useAbandonedCarts';
import { usePaymentAbandonments } from '@admin/app/stores/[id]/payment-abandonments/_hooks/usePaymentAbandonments';
import { useAnswerEngineSummary } from '@admin/app/stores/[id]/answer-engine/_hooks/useAnswerEngineSummary';
import { useGscDashboard } from '@admin/app/stores/[id]/answer-engine/_hooks/useGscDashboard';

const FORBIDDEN = { data: null, error: { code: 'FORBIDDEN', message: 'Forbidden', status: 403 } };
const OK = { data: null, error: null };

beforeEach(() => apiGet.mockReset());
afterEach(() => cleanup());

/** Fail only the calls whose URL contains `needle`; succeed (empty) otherwise. */
function failOn(needle: string) {
  apiGet.mockImplementation(async (...args: unknown[]) =>
    String(args[0]).includes(needle) ? FORBIDDEN : OK
  );
}

const cases: Array<{
  name: string;
  needle: string;
  run: () => { current: { error: string | null } & Record<string, unknown> };
  loadingKey: string;
}> = [
  {
    // /cashflow is excluded on purpose: its 402/403 is a LOCKED card (BE:S-4), covered in useAnalytics.test.ts.
    name: 'useAnalytics (one of six calls fails)',
    needle: '/top-products',
    run: () =>
      renderHook(() => useAnalytics({ storeId: 's1', period: 'this_month' })).result as never,
    loadingKey: 'isLoading',
  },
  {
    name: 'useAbandonedCarts',
    needle: '/abandoned-carts/stats',
    run: () =>
      renderHook(() => useAbandonedCarts({ storeId: 's1', enabled: true })).result as never,
    loadingKey: 'loading',
  },
  {
    name: 'usePaymentAbandonments',
    needle: '/payment-abandonments/stats',
    run: () =>
      renderHook(() => usePaymentAbandonments({ storeId: 's1', enabled: true })).result as never,
    loadingKey: 'loading',
  },
  {
    name: 'useAnswerEngineSummary',
    needle: '/answer-engine/summary',
    run: () =>
      renderHook(() => useAnswerEngineSummary({ storeId: 's1', enabled: true })).result as never,
    loadingKey: 'isLoading',
  },
  {
    name: 'useGscDashboard',
    needle: '/answer-engine/gsc',
    run: () => renderHook(() => useGscDashboard({ storeId: 's1', enabled: true })).result as never,
    loadingKey: 'isLoading',
  },
];

describe('report hooks surface API errors', () => {
  for (const c of cases) {
    it(`${c.name}: a failed call sets error`, async () => {
      failOn(c.needle);
      const result = c.run();
      await waitFor(() => expect(result.current[c.loadingKey]).toBe(false));
      expect(result.current.error).toBe('Forbidden');
    });

    it(`${c.name}: all calls succeed → error stays null`, async () => {
      apiGet.mockResolvedValue(OK);
      const result = c.run();
      await waitFor(() => expect(result.current[c.loadingKey]).toBe(false));
      expect(result.current.error).toBeNull();
    });
  }

  // Issue 2256: /dashboard answers 200 with `stats: null` when a sub-query
  // rejects (Promise.allSettled). Detection by HTTP status alone missed it and
  // the page rendered EGP 0.000 revenue with no banner.
  it('useAnalytics: a 200 dashboard with failed sub-queries is an error, not zeros', async () => {
    apiGet.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).includes('/dashboard?')
        ? { data: { stats: null, gl: null, stock: null, failed: ['stats'] }, error: null }
        : OK
    );
    const result = renderHook(() => useAnalytics({ storeId: 's1', period: 'this_month' })).result;
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('');
  });

  it('useAnalytics: a 200 dashboard with an empty `failed` list is not an error', async () => {
    apiGet.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).includes('/dashboard?')
        ? { data: { stats: null, gl: null, stock: null, failed: [] }, error: null }
        : OK
    );
    const result = renderHook(() => useAnalytics({ storeId: 's1', period: 'this_month' })).result;
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('useAnalytics sends the viewer tzOffset and the range to every range-aware call', async () => {
    apiGet.mockResolvedValue(OK);
    const result = renderHook(() => useAnalytics({ storeId: 's1', period: 'this_year' })).result;
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const urls = apiGet.mock.calls.map(c => c[0] as string);
    const sales = urls.find(u => u.includes('/sales?'))!;
    expect(sales).toMatch(/tzOffset=-?\d+/);
    for (const path of ['/dashboard?', '/sales?', '/top-products?', '/cashflow?']) {
      const u = urls.find(x => x.includes(path))!;
      expect(u, path).toContain('startDate=');
      expect(u, path).toContain('endDate=');
    }
  });
});
