// @vitest-environment jsdom
/**
 * Owner report 2026-09-30 ("the selected filter does not apply"): every
 * range-aware analytics call must carry the SELECTED range, under the shared
 * contract's param names, and a slower response for the previous range must
 * never overwrite the current one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { parseReportRange } from '@ebda/shared';

const apiGet = vi.fn();
vi.mock('../../../../../lib/api', () => ({ apiGet: (url: string) => apiGet(url) }));

import { useAnalytics } from './useAnalytics';

afterEach(() => {
  cleanup();
  apiGet.mockReset();
});

function ok(url: string) {
  if (url.includes('/dashboard'))
    return { data: { stats: { totalRevenue: 1 }, gl: null, stock: null, failed: [] } };
  if (url.includes('/sales')) return { data: { sales: [], granularity: 'day' } };
  if (url.includes('/cashflow')) return { data: { trend: [] } };
  if (url.includes('/recent-orders')) return { data: { orders: [] } };
  return { data: { products: [] } };
}

const RANGE_AWARE = ['/dashboard', '/sales', '/top-products', '/cashflow'];

function rangeOf(url: string) {
  const q = Object.fromEntries(new URL(url, 'http://x').searchParams);
  const parsed = parseReportRange(q);
  if (!parsed.ok) throw new Error(`unparseable range in ${url}`);
  return parsed.range;
}

describe('useAnalytics sends the selected range', () => {
  it('every range-aware call carries the custom range, parseable by the API contract', async () => {
    apiGet.mockImplementation(async (url: string) => ok(url));
    const aug = {
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-31T23:59:59.999Z'),
    };
    renderHook(() => useAnalytics({ storeId: 's1', period: 'custom', customRange: aug }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(6));

    for (const path of RANGE_AWARE) {
      const url = apiGet.mock.calls.map(c => c[0] as string).find(u => u.includes(path))!;
      expect(rangeOf(url)).toEqual(aug);
    }
    // Deliberately NOT period-based (their card titles say so).
    for (const path of ['/recent-orders', '/low-stock']) {
      const url = apiGet.mock.calls.map(c => c[0] as string).find(u => u.includes(path))!;
      expect(rangeOf(url)).toBeUndefined();
    }
  });

  it('a different selected range changes every range-aware request', async () => {
    apiGet.mockImplementation(async (url: string) => ok(url));
    const aug = {
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-31T23:59:59.999Z'),
    };
    const sep = {
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: new Date('2026-09-30T23:59:59.999Z'),
    };
    const { rerender } = renderHook(
      ({ r }) => useAnalytics({ storeId: 's1', period: 'custom', customRange: r }),
      { initialProps: { r: aug } }
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(6));
    rerender({ r: sep });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(12));
    const second = apiGet.mock.calls.slice(6).map(c => c[0] as string);
    for (const path of RANGE_AWARE) {
      expect(rangeOf(second.find(u => u.includes(path))!)).toEqual(sep);
    }
  });

  it('a slow response for the previous range does not overwrite the current one', async () => {
    let releaseOld: () => void = () => {};
    const oldGate = new Promise<void>(r => (releaseOld = r));
    apiGet.mockImplementation(async (url: string) => {
      const august = url.includes(encodeURIComponent('2026-08-01'));
      if (url.includes('/dashboard')) {
        if (august) await oldGate;
        return {
          data: { stats: { totalRevenue: august ? 111 : 222 }, gl: null, stock: null, failed: [] },
        };
      }
      return ok(url);
    });
    const aug = {
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-31T23:59:59.999Z'),
    };
    const sep = {
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: new Date('2026-09-30T23:59:59.999Z'),
    };
    const { result, rerender } = renderHook(
      ({ r }) => useAnalytics({ storeId: 's1', period: 'custom', customRange: r }),
      { initialProps: { r: aug } }
    );
    rerender({ r: sep });
    await waitFor(() => expect(result.current.stats?.totalRevenue).toBe(222));
    releaseOld();
    await new Promise(r => setTimeout(r, 20));
    expect(result.current.stats?.totalRevenue).toBe(222);
  });
});

describe('useAnalytics: owner + accounting-only cashflow (BE:S-4)', () => {
  const refusal = (status: number, code: string) => ({
    data: null,
    error: { code, message: 'raw api text', status },
  });

  it.each([
    ['plan refusal', 402, 'PLAN_REQUIRED'],
    ['feature off', 403, 'FEATURE_DISABLED'],
    ['role refusal', 403, 'FORBIDDEN'],
  ])('a cashflow %s is a locked card, not an error banner', async (_n, status, code) => {
    apiGet.mockImplementation(async (url: string) =>
      url.includes('/cashflow') ? refusal(status, code) : ok(url)
    );
    const { result } = renderHook(() => useAnalytics({ storeId: 's1', period: 'this_month' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.cashflowLocked).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('a server error on cashflow is still an error, not a lock', async () => {
    apiGet.mockImplementation(async (url: string) =>
      url.includes('/cashflow') ? refusal(500, 'SERVER_ERROR') : ok(url)
    );
    const { result } = renderHook(() => useAnalytics({ storeId: 's1', period: 'this_month' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.cashflowLocked).toBe(false);
    expect(result.current.error).toBe('raw api text');
  });
});
