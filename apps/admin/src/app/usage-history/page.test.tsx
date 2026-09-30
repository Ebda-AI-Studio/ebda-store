// @vitest-environment jsdom
/**
 * Issue 1058 — `store_usage_snapshots` (the monthly per-store usage history
 * the tier-sizing work exists to produce) had an API and no viewer. Open
 * /usage-history → the selected month's rows render, newest month first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../components/RequireSuperAdmin', () => ({
  RequireSuperAdmin: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import UsageHistoryPage from './page';

const store = (name: string, revenueFils: string, aiUnpricedCalls = 0) => ({
  storeId: `id-${name}`,
  slug: name.toLowerCase(),
  name,
  plan: 'starter',
  products: 40,
  productsActive: 31,
  variants: 12,
  images: 80,
  categories: 5,
  orders: 17,
  revenueFils,
  customers: 9,
  sessionsProxy: 120,
  cartsWithItems: 22,
  productViews: '1500',
  aiCalls: 64,
  aiBillableCalls: 60,
  aiCostMicros: '2500000',
  aiUnpricedCalls,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('super-admin usage history page (issue 1058)', () => {
  it('renders the newest month rows, highest revenue first, and switches months', async () => {
    apiGet.mockResolvedValue({
      data: {
        periods: [
          {
            periodStart: '2026-09-01',
            stores: [store('Alpha', '120000'), store('Beta', '980500', 3)],
          },
          { periodStart: '2026-08-01', stores: [store('Gamma', '5000')] },
        ],
      },
      error: null,
    });
    render(<UsageHistoryPage />);

    const beta = await screen.findByText('Beta');
    const alpha = screen.getByText('Alpha');
    // Revenue desc: Beta (980.500) before Alpha (120.000).
    expect(beta.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('980.500')).toBeTruthy();
    expect(screen.getByText('table.aiUnpriced:{"count":"3"}')).toBeTruthy();
    expect(String(apiGet.mock.calls[0][0])).toContain('/admin/super-admin/usage-history');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2026-08-01' } });
    expect(await screen.findByText('Gamma')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('says so when no snapshot exists yet, instead of an empty table', async () => {
    apiGet.mockResolvedValue({ data: { periods: [] }, error: null });
    render(<UsageHistoryPage />);
    expect(await screen.findByText('empty')).toBeTruthy();
  });
});
