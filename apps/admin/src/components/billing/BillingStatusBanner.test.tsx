// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { apiGet, pathname } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  pathname: { current: '/stores/s1/products' },
}));
vi.mock('../../lib/api', () => ({ apiGet }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import { BillingStatusBanner } from './BillingStatusBanner';
import { billingNotice } from './notice';
import { billingFixture } from './fixtures';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pathname.current = '/stores/s1/products';
});

const reply = (billing: unknown) => apiGet.mockResolvedValue({ data: { billing }, error: null });

describe('BillingStatusBanner', () => {
  it('fetches billing once for the store and links an unpaid suspension to the billing page', async () => {
    reply(billingFixture({ suspension: { reason: 'unpaid', at: '2026-11-01T00:00:00.000Z' } }));
    render(<BillingStatusBanner storeId="s1" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('unpaidTitle');
    expect(screen.getByRole('link', { name: 'view' }).getAttribute('href')).toBe(
      '/stores/s1/billing'
    );
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/api/v1/stores/s1/billing');
  });

  it('shows due-soon (<=7 days) as a calm status, and nothing for a healthy store', async () => {
    reply(billingFixture({ dueSoon: { dueAt: '2026-11-08T00:00:00.000Z', daysLeft: 4 } }));
    render(<BillingStatusBanner storeId="s1" />);
    expect((await screen.findByRole('status')).textContent).toContain('dueSoonTitle:{"n":4}');
    cleanup();

    reply(billingFixture({ dueSoon: { dueAt: '2026-11-20T00:00:00.000Z', daysLeft: 16 } }));
    const { container } = render(<BillingStatusBanner storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(container.textContent).toBe('');
  });

  it('is hidden on the billing page itself (it shows the full notice there)', async () => {
    pathname.current = '/stores/s1/billing';
    reply(billingFixture({ overdue: true }));
    const { container } = render(<BillingStatusBanner storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('a failed fetch shows nothing (the page itself surfaces billing errors)', async () => {
    apiGet.mockResolvedValue({ data: null, error: { code: 'X', message: 'x', status: 500 } });
    const { container } = render(<BillingStatusBanner storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('billingNotice priority', () => {
  it('unpaid beats over-limit beats overdue beats due-soon', () => {
    const all = billingFixture({
      suspension: { reason: 'unpaid', at: 'x' },
      overdue: true,
      dueSoon: { dueAt: 'x', daysLeft: 1 },
    });
    expect(billingNotice(all)).toBe('unpaid');
    expect(billingNotice({ ...all, suspension: { reason: 'over_store_limit', at: 'x' } })).toBe(
      'overStoreLimit'
    );
    expect(billingNotice({ ...all, suspension: null })).toBe('overdue');
    expect(billingNotice({ ...all, suspension: null, overdue: false })).toBe('dueSoon');
    expect(billingNotice(null)).toBeNull();
  });
});

describe('last day of grace (BILL-NOTICE-1)', () => {
  it('shows the louder grace-ending notice within a day of suspension, the plain overdue one before', () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(billingNotice(billingFixture({ overdue: true, suspendAt: soon }))).toBe('graceEnding');
    expect(billingNotice(billingFixture({ overdue: true, suspendAt: later }))).toBe('overdue');
  });
});
