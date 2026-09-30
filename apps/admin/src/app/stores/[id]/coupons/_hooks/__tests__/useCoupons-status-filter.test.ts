// @vitest-environment jsdom
/**
 * Owner report 2026-09-30 ("the selected filter does not apply"): the status
 * filter refetched through `setTimeout(fetchCoupons)`, a closure from the
 * render BEFORE the change, so each request carried the PREVIOUS status.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const apiGet = vi.fn(async (_url: string) => ({ data: { coupons: [] } }));
vi.mock('../../../../../../lib/api', () => ({
  apiGet: (url: string) => apiGet(url),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

import { useCoupons } from '../useCoupons';

afterEach(() => {
  cleanup();
  apiGet.mockClear();
});

const lastUrl = () => String(apiGet.mock.calls.at(-1)?.[0] ?? '');

describe('useCoupons status filter', () => {
  it('each selection fetches with THAT selection, not the previous one', async () => {
    const { result } = renderHook(() => useCoupons('s1'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(lastUrl()).not.toContain('isActive');

    act(() => result.current.setFilterActive('active'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(lastUrl()).toContain('isActive=true');

    act(() => result.current.setFilterActive('inactive'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(lastUrl()).toContain('isActive=false');
  });
});
