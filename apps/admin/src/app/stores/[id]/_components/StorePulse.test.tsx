// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}|${JSON.stringify(v)}` : k),
}));
vi.mock('@ebda/ui', () => ({
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock('../../../../lib/format', () => ({ formatPrice: (n: number) => `EGP ${n}` }));

import { KpiRow, SalesHero, TopProductsCard, PeriodSwitch } from './StorePulse';

afterEach(cleanup);
const stats = {
  totalRevenue: 125000,
  totalOrders: 8,
  totalCustomers: 5,
  averageOrderValue: 15625,
  conversionRate: null,
  revenueChange: 25,
  ordersChange: -10,
  customersChange: 0,
};
const noop = () => {};

describe('SalesHero', () => {
  it('loading renders a skeleton, never zero', () => {
    render(<SalesHero stats={null} sales={null} period="last_7" onRetry={noop} onShare={noop} />);
    expect(screen.getByTestId('hero-skeleton')).toBeTruthy();
    expect(screen.queryByText('EGP 0')).toBeNull();
  });
  it('error shows an alert with a retry that fires', () => {
    const retry = vi.fn();
    render(<SalesHero stats="error" sales={null} period="last_7" onRetry={retry} onShare={noop} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText('retry'));
    expect(retry).toHaveBeenCalled();
  });
  it('shows revenue with an up delta and the plain-language sentence', () => {
    render(
      <SalesHero
        stats={stats}
        sales={[
          { date: '2026-11-01', revenue: 1, orders: 1 },
          { date: '2026-11-02', revenue: 2, orders: 1 },
        ]}
        period="last_7"
        onRetry={noop}
        onShare={noop}
      />
    );
    expect(screen.getByText('EGP 125000')).toBeTruthy();
    expect(screen.getByTestId('delta').getAttribute('data-tone')).toBe('up');
    expect(screen.getByText(/sentence\.up/)).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
  });
  it('an empty period teaches the next step and offers the share action', () => {
    const share = vi.fn();
    render(
      <SalesHero
        stats={{ ...stats, totalRevenue: 0, totalOrders: 0, revenueChange: 0 }}
        sales={[]}
        period="today"
        onRetry={noop}
        onShare={share}
      />
    );
    expect(screen.getByTestId('hero-empty')).toBeTruthy();
    fireEvent.click(screen.getByText('emptyCta'));
    expect(share).toHaveBeenCalled();
  });
});

describe('KpiRow', () => {
  it('unknown conversion is a dash, not 0%; unpaid links to the filtered orders', () => {
    render(<KpiRow stats={stats} unpaid={{ orders: 3, revenue: 9000 }} storeId="s1" />);
    expect(screen.getByTestId('kpi-conversion').textContent).toContain('—');
    expect(screen.getByTestId('kpi-conversion').textContent).not.toContain('0%');
    expect(screen.getByTestId('kpi-unpaid').getAttribute('href')).toBe(
      '/stores/s1/orders?paymentStatus=pending'
    );
  });
  it('a failed unpaid read is a dash with a note, not zero', () => {
    render(<KpiRow stats={stats} unpaid="error" storeId="s1" />);
    expect(screen.getByTestId('kpi-unpaid').textContent).toContain('unpaidFailed');
  });
  it('stats error renders nothing (the hero owns the error)', () => {
    const { container } = render(<KpiRow stats="error" unpaid={null} storeId="s1" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('TopProductsCard', () => {
  it('lists products, empty state teaches, error retries', () => {
    const { rerender } = render(
      <TopProductsCard
        products={[{ id: 'p1', name: 'Ring', revenue: 500, quantity: 2 }]}
        storeId="s1"
        onRetry={noop}
      />
    );
    expect(screen.getByText('Ring')).toBeTruthy();
    rerender(<TopProductsCard products={[]} storeId="s1" onRetry={noop} />);
    expect(screen.getByTestId('top-empty')).toBeTruthy();
    rerender(<TopProductsCard products="error" storeId="s1" onRetry={noop} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('PeriodSwitch', () => {
  it('is a radiogroup and reports the picked period', () => {
    const onChange = vi.fn();
    render(<PeriodSwitch value="last_7" onChange={onChange} />);
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    fireEvent.click(screen.getByText('period.this_month'));
    expect(onChange).toHaveBeenCalledWith('this_month');
  });
});

describe('first sales (D1)', () => {
  it('shows a "new" pill and the first-sales sentence instead of "Up 100%"', () => {
    render(
      <SalesHero
        stats={{ ...stats, revenueChange: 100, previousRevenue: 0, previousOrders: 0 }}
        sales={null}
        period="last_7"
        onRetry={noop}
        onShare={noop}
      />
    );
    const pill = screen.getByTestId('delta');
    expect(pill.getAttribute('data-tone')).toBe('new');
    expect(pill.textContent).not.toContain('100%');
    expect(screen.getByText(/^sentence\.new\|/)).toBeTruthy();
  });
  it('shows no pill when neither period had sales on the orders KPI', () => {
    render(
      <KpiRow
        stats={{ ...stats, totalOrders: 0, ordersChange: 0, previousOrders: 0 }}
        unpaid={{ orders: 0, revenue: 0 }}
        storeId="s1"
      />
    );
    expect(screen.getByTestId('kpi-orders').querySelector('[data-testid="delta"]')).toBeNull();
  });
});
