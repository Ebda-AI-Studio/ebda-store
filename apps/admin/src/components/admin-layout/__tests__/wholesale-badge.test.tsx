// @vitest-environment jsdom
/**
 * B2B review I5 / Task 7: the pending-applications badge on the customers tab and the Wholesale applications tab. It shows only
 * while the count is above 0 and the store is on the plan, makes no request for a store that is not, and the new tab is NOT
 * feature-keyed (the page itself shows the upgrade prompt).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { HUBS, type HubLabels } from '../hubs';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  usePathname: () => '/stores/store-1/orders',
}));
const feat = vi.hoisted(() => ({ on: true }));
vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => feat.on, isLoading: false, refresh: async () => {} }),
}));
const apiGet = vi.fn();
vi.mock('../../../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));
vi.mock('../../../contexts/NotificationContext', () => ({
  useNotifications: () => ({ notifications: [] }),
}));

import { HubTabs } from '../HubTabs';

const labels = new Proxy({} as HubLabels, { get: (_t, key) => String(key) });
const sales = HUBS.find(h => h.key === 'sales')!;
const tabs = () => sales.buildTabs('store-1', labels);

beforeEach(() => {
  apiGet.mockReset();
  feat.on = true;
});
afterEach(cleanup);

describe('wholesale pending badge', () => {
  it('both the customers tab and the Wholesale applications tab carry it; the new tab is routed to the Sales hub and not feature-keyed', () => {
    const t = tabs();
    expect(t.filter(x => x.badgeKey === 'wholesalePending').map(x => x.href)).toEqual([
      '/stores/store-1/customers',
      '/stores/store-1/wholesale-applications',
    ]);
    expect(t.find(x => x.href.endsWith('/wholesale-applications'))?.featureKey).toBeUndefined();
    expect(sales.urlPrefixes).toContain('/wholesale-applications');
  });

  it('shows the pending count on both tabs when the store is on the plan', async () => {
    apiGet.mockResolvedValue({
      data: { pendingCount: 3, oldestPendingHours: 5, overdue: false },
      error: null,
    });
    render(<HubTabs items={tabs()} />);
    await waitFor(() => expect(screen.getAllByTestId('wholesale-pending-badge')).toHaveLength(2));
    expect(screen.getAllByTestId('wholesale-pending-badge')[0]!.textContent).toBe('3');
    expect(apiGet).toHaveBeenCalledWith('/api/v1/stores/store-1/wholesale-applications/summary');
  });

  it('no badge for zero pending', async () => {
    apiGet.mockResolvedValue({
      data: { pendingCount: 0, oldestPendingHours: null, overdue: false },
      error: null,
    });
    render(<HubTabs items={tabs()} />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryAllByTestId('wholesale-pending-badge')).toHaveLength(0);
  });

  it('a store without the plan makes no request and shows no badge', () => {
    feat.on = false;
    render(<HubTabs items={tabs()} />);
    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId('wholesale-pending-badge')).toHaveLength(0);
  });
});
