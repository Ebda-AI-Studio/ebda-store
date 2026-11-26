// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key;
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
const apiGet = vi.fn();
vi.mock('../../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));

import { PlanLimitNotice } from './PlanLimitNotice';
import { aiMeter, billingMeters } from './usePlanMeters';

const limits = { maxProducts: 100, maxStaff: 5, maxOrdersPerMonth: null, maxStorageMb: 500 };
const billing = (products: number) => ({
  data: {
    limits,
    usage: { maxProducts: products, maxStaff: 1, maxOrdersPerMonth: 9999, maxStorageMb: null },
  },
});

beforeEach(() => apiGet.mockReset());
afterEach(cleanup);

describe('billingMeters (same payload the billing page meters)', () => {
  const at = (n: number) =>
    billingMeters(billing(n).data, ['maxProducts', 'maxOrdersPerMonth', 'maxStorageMb']);
  it('79% -> nothing', () => expect(at(79)).toEqual([]));
  it('80% -> warn', () => expect(at(80)).toMatchObject([{ key: 'maxProducts', level: 'warn' }]));
  it('100% -> full', () => expect(at(100)).toMatchObject([{ key: 'maxProducts', level: 'full' }]));
  it('unlimited and unreadable counters never warn', () => expect(at(10).length).toBe(0));
});

describe('aiMeter', () => {
  const s = (today: number, month: number) => ({
    today,
    thisMonth: month,
    dailyCap: 100,
    monthlyCap: 1000,
  });
  it('79% -> null', () => expect(aiMeter(s(79, 790))).toBeNull());
  it('80% monthly -> warn monthly', () =>
    expect(aiMeter(s(0, 800))).toMatchObject({ level: 'warn', window: 'monthly' }));
  it('100% daily wins over 80% monthly', () =>
    expect(aiMeter(s(100, 800))).toMatchObject({ level: 'full', window: 'daily' }));
});

describe('<PlanLimitNotice>', () => {
  it('renders nothing at 79%', async () => {
    apiGet.mockResolvedValue(billing(79));
    const { container } = render(<PlanLimitNotice storeId="s1" keys={['maxProducts']} />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="plan-limit-notices"]')).toBeNull();
  });
  it('80%: warn card with an upgrade CTA to billing (not an error)', async () => {
    apiGet.mockResolvedValue(billing(80));
    render(<PlanLimitNotice storeId="s1" keys={['maxProducts']} />);
    const card = await screen.findByTestId('plan-limit-maxProducts');
    expect(card.getAttribute('data-level')).toBe('warn');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/stores/s1/billing');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('100%: full card', async () => {
    apiGet.mockResolvedValue(billing(100));
    render(<PlanLimitNotice storeId="s1" keys={['maxProducts']} />);
    expect((await screen.findByTestId('plan-limit-maxProducts')).getAttribute('data-level')).toBe(
      'full'
    );
  });
  it('a failed request (e.g. staff 403) renders nothing', async () => {
    apiGet.mockResolvedValue({ data: null, error: 'x' });
    const { container } = render(<PlanLimitNotice storeId="s1" keys={['maxProducts']} />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
  it('AI key reads the AI summary, not billing', async () => {
    apiGet.mockResolvedValue({
      data: { today: 90, thisMonth: 10, dailyCap: 100, monthlyCap: 1000 },
    });
    render(<PlanLimitNotice storeId="s1" keys={['ai']} />);
    expect((await screen.findByTestId('plan-limit-ai')).getAttribute('data-level')).toBe('warn');
    expect(apiGet).toHaveBeenCalledWith('/api/v1/stores/s1/ai/usage/summary');
  });
});
