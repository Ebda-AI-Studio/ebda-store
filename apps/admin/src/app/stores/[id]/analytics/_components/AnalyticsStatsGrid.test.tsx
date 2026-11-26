// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 's1' }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AnalyticsStatsGrid } from './AnalyticsStatsGrid';
import type { DashboardStats } from './types';

afterEach(cleanup);
const base: DashboardStats = {
  totalRevenue: 1000,
  totalOrders: 4,
  totalCustomers: 3,
  totalProducts: 9,
  averageOrderValue: 250,
  revenueChange: 100,
  ordersChange: 100,
  customersChange: 100,
  totalProfit: null,
  profitChange: null,
};

describe('AnalyticsStatsGrid delta', () => {
  it('previous period 0 with sales now shows "New", never +100.0%', () => {
    render(
      <AnalyticsStatsGrid
        stats={{ ...base, previousRevenue: 0, previousOrders: 0, previousCustomers: 0 }}
      />
    );
    expect(screen.getAllByText('newVsPrevious').length).toBe(3);
    expect(screen.queryByText('100.0%')).toBeNull();
  });

  it('a real previous period still shows the percentage', () => {
    render(
      <AnalyticsStatsGrid
        stats={{
          ...base,
          revenueChange: 25,
          ordersChange: 25,
          customersChange: 25,
          previousRevenue: 800,
          previousOrders: 3,
          previousCustomers: 2,
        }}
      />
    );
    expect(screen.queryByText('newVsPrevious')).toBeNull();
    expect(screen.getAllByText('25.0%').length).toBe(3);
  });

  it('both periods 0 shows no delta at all', () => {
    render(
      <AnalyticsStatsGrid
        stats={{
          ...base,
          totalRevenue: 0,
          totalOrders: 0,
          totalCustomers: 0,
          revenueChange: 0,
          ordersChange: 0,
          customersChange: 0,
          previousRevenue: 0,
          previousOrders: 0,
          previousCustomers: 0,
        }}
      />
    );
    expect(screen.queryByText('newVsPrevious')).toBeNull();
    expect(screen.queryByText('0.0%')).toBeNull();
  });
});
