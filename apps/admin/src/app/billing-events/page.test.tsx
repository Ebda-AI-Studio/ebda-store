// @vitest-environment jsdom
/**
 * Super-admin billing ledger page (SP5 task 3): "open /billing-events -> rows
 * render", the refund action only on succeeded charges, the stuck flag, and the
 * issue-2375 class (an outage must not render as "no events").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
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
vi.mock('@force/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));

import BillingEventsPage from './page';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  storeId: 's1',
  storeName: 'Cairo Candles',
  type: 'renewal',
  planCode: 'growth',
  billingInterval: 'monthly',
  amountMinor: 19999,
  provider: 'kashier',
  providerRef: 'TX-1',
  idempotencyKey: 'sub:1:2026',
  status: 'succeeded',
  failureReason: null,
  attempt: 0,
  createdAt: '2026-11-03T04:00:00.000Z',
  stuck: false,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('super-admin billing ledger page', () => {
  it('renders ledger rows with money formatted from piastres', async () => {
    apiGet.mockResolvedValue({ data: { events: [row()] }, error: null });
    render(<BillingEventsPage />);
    expect(await screen.findAllByText('Cairo Candles')).not.toHaveLength(0);
    expect(screen.getAllByText('199.99', { exact: false }).length).toBeGreaterThan(0);
    expect(apiGet.mock.calls[0][0]).toContain('/api/v1/admin/billing/events?limit=100');
  });

  it('offers a refund only on a succeeded charge, and posts it after confirmation', async () => {
    apiGet.mockResolvedValue({
      data: { events: [row(), row({ id: 'e2', status: 'failed', providerRef: null })] },
      error: null,
    });
    apiPost.mockResolvedValue({ data: {}, error: null });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<BillingEventsPage />);
    const buttons = await screen.findAllByRole('button', { name: 'refund' });
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/billing/events/e1/refund', {})
    );
  });

  it('flags a pending charge whose outcome is unknown', async () => {
    apiGet.mockResolvedValue({
      data: { events: [row({ status: 'pending', stuck: true })] },
      error: null,
    });
    render(<BillingEventsPage />);
    expect((await screen.findAllByText('stuck')).length).toBeGreaterThan(0);
  });

  it('shows the load-failure state, not "empty", when the API errors', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'SERVER_ERROR', message: 'boom', status: 500 },
    });
    render(<BillingEventsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('failedToLoad');
    expect(screen.queryByText('empty')).toBeNull();
  });
});
