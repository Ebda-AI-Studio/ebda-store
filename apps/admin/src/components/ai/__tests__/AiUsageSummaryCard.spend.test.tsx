// @vitest-environment jsdom
/**
 * Issues 2204/2226 — `/ai/usage/summary` returned AI spend (+ how many calls
 * that spend excludes) and no merchant surface read it. The card now renders
 * the amount, "—" when nothing in the window is priced (unknown, never 0),
 * and the floor caveat whenever unpriced calls exist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiGet }));
const { auth } = vi.hoisted(() => ({ auth: { role: 'super_admin' } }));
vi.mock('../../../lib/auth', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import { AiUsageSummaryCard } from '../AiUsageSummaryCard';

const base = { today: 3, thisMonth: 40, dailyCap: 100, monthlyCap: 2000, last30Days: [] };

afterEach(() => {
  auth.role = 'super_admin';
  cleanup();
  vi.clearAllMocks();
});

describe('AiUsageSummaryCard spend (issues 2204/2226)', () => {
  it('renders the month spend and says it is a floor when calls are unpriced', async () => {
    apiGet.mockResolvedValue({
      data: {
        ...base,
        todayCostMicros: 1_250_000,
        todayUnpricedCount: 0,
        monthCostMicros: 12_345_600,
        monthUnpricedCount: 7,
      },
      error: null,
    });
    render(<AiUsageSummaryCard storeId="s1" />);
    expect(await screen.findByText('12.3456')).toBeTruthy();
    expect(screen.getByText('1.2500')).toBeTruthy();
    expect(screen.getByText('spendUnpriced:{"count":"7"}')).toBeTruthy();
  });

  it('renders an unpriced-only window as unknown (—), never 0', async () => {
    apiGet.mockResolvedValue({
      data: { ...base, todayCostMicros: null, monthCostMicros: null, monthUnpricedCount: 4 },
      error: null,
    });
    render(<AiUsageSummaryCard storeId="s1" embedded />);
    await screen.findByText('spendMonth');
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('hides the cost-accounting floor caveat from a store owner (A1)', async () => {
    auth.role = 'store_admin';
    apiGet.mockResolvedValue({
      data: {
        ...base,
        todayCostMicros: 1_250_000,
        monthCostMicros: 12_345_600,
        monthUnpricedCount: 59,
      },
      error: null,
    });
    render(<AiUsageSummaryCard storeId="s1" />);
    expect(await screen.findByText('12.3456')).toBeTruthy();
    expect(screen.queryByText(/spendUnpriced/)).toBeNull();
  });
});
