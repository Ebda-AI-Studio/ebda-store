// @vitest-environment jsdom
/**
 * Wholesale vs retail card on the analytics page: plan-gated like the wholesale feature (no request, no markup for a store
 * that is not on the plan), shows the server split verbatim, and says so when a load fails instead of drawing zeros.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ apiGet: vi.fn(), on: true, loading: false }));
vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('@/lib/api', () => ({ apiGet: h.apiGet }));
vi.mock('../../../../../hooks/useFeatures', () => ({
  useFeatures: () => ({
    isEnabled: (k: string) => h.on && k === 'b2b.wholesale',
    isLoading: h.loading,
    refresh: async () => {},
  }),
}));

import { PriceSourceCard } from './PriceSourceCard';

const split = {
  retail: { revenue: 600000, units: 40 },
  tier: { revenue: 300000, units: 30 },
  group: { revenue: 100000, units: 10 },
  wholesale: { revenue: 400000, units: 40 },
  wholesaleSharePercent: 40,
};

beforeEach(() => {
  h.on = true;
  h.loading = false;
  h.apiGet.mockReset();
});
afterEach(cleanup);

describe('PriceSourceCard', () => {
  it('requests the split for the picked range and renders the share and the three rows', async () => {
    h.apiGet.mockResolvedValue({ data: split });
    render(<PriceSourceCard storeId="store-1" rangeQs="startDate=a&endDate=b" />);
    await waitFor(() => expect(screen.getByTestId('price-source-tier')).toBeTruthy());
    expect(h.apiGet).toHaveBeenCalledWith(
      '/api/v1/stores/store-1/analytics/price-source?startDate=a&endDate=b'
    );
    expect(screen.getByText('40%')).toBeTruthy();
    expect(screen.getByTestId('price-source-retail').textContent).toContain('40');
    expect(screen.getByTestId('price-source-group').textContent).toContain('10');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('40');
  });

  it('is plan-gated: no request and no card when the store is not on the wholesale plan', () => {
    h.on = false;
    const { container } = render(<PriceSourceCard storeId="store-1" rangeQs="x=1" />);
    expect(container.innerHTML).toBe('');
    expect(h.apiGet).not.toHaveBeenCalled();
  });

  it('waits for the feature list before deciding (no request while it is still loading)', () => {
    h.loading = true;
    const { container } = render(<PriceSourceCard storeId="store-1" rangeQs="x=1" />);
    expect(container.innerHTML).toBe('');
    expect(h.apiGet).not.toHaveBeenCalled();
  });

  it('says it failed instead of drawing zeros, and says so when there are no sales', async () => {
    h.apiGet.mockResolvedValue({ error: { message: 'x' } });
    render(<PriceSourceCard storeId="store-1" rangeQs="x=1" />);
    expect(await screen.findByText('loadFailed')).toBeTruthy();
    cleanup();
    h.apiGet.mockResolvedValue({
      data: {
        retail: { revenue: 0, units: 0 },
        tier: { revenue: 0, units: 0 },
        group: { revenue: 0, units: 0 },
        wholesale: { revenue: 0, units: 0 },
        wholesaleSharePercent: 0,
      },
    });
    render(<PriceSourceCard storeId="store-1" rangeQs="x=1" />);
    expect(await screen.findByText('empty')).toBeTruthy();
  });
});
