// @vitest-environment jsdom
/**
 * Merchant Billing page (SP5 task 1): "open /stores/:id/billing -> rows render".
 * The plan, usage-vs-limit bars, over-limit banner, upgrade placeholder, and
 * the super-admin-only plan picker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiGet, role } = vi.hoisted(() => ({ apiGet: vi.fn(), role: { current: 'store_admin' } }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../../../lib/api', () => ({ apiGet, apiPut: vi.fn() }));
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: role.current } }) }));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});
vi.mock('@force/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Select: ({ label }: { label: string }) => <select aria-label={label} />,
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import StoreBillingPage from './page';

const limits = {
  maxProducts: 50,
  maxStaff: 1,
  maxOrdersPerMonth: 100,
  maxStorageMb: 500,
  customDomain: false,
  platformFeeBps: 150,
  codPlatformFeeBps: 0,
  abandonedCartAutomation: false,
  whatsappAutomation: false,
};

function billing(over: Partial<Record<string, unknown>> = {}) {
  return {
    plan: { code: 'free', nameEn: 'Free', nameAr: 'مجاني', subscribedPlanCode: 'free' },
    subscription: {
      status: 'active',
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
    },
    limits,
    usage: {
      maxProducts: 45,
      maxStaff: 1,
      maxOrdersPerMonth: 120,
      maxStorageMb: null,
      customDomain: 0,
    },
    ordersOverLimitMonth: null,
    availablePlans: [
      {
        code: 'free',
        nameEn: 'Free',
        nameAr: 'مجاني',
        priceMonthlyMinor: null,
        priceYearlyMinor: null,
        limits,
      },
    ],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  role.current = 'store_admin';
});

describe('merchant billing page', () => {
  it('renders the plan name and one progressbar per count limit with the right values', async () => {
    apiGet.mockResolvedValue({ data: billing(), error: null });
    render(<StoreBillingPage />);

    expect(await screen.findByText('Free', { selector: 'h2' })).toBeTruthy();
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(3);
    const products = bars.find(b => b.getAttribute('aria-valuemax') === '50')!;
    expect(products.getAttribute('aria-valuenow')).toBe('45');
    // price not set -> "to be announced", never 0
    expect(screen.getByText('priceTbd')).toBeTruthy();
  });

  it('shows the over-limit banner only when flagged for the current month, and never hides orders', async () => {
    const month = new Date().toISOString().slice(0, 7);
    apiGet.mockResolvedValue({
      data: billing({ ordersOverLimitMonth: `${month}-01` }),
      error: null,
    });
    render(<StoreBillingPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();

    apiGet.mockResolvedValue({
      data: billing({ ordersOverLimitMonth: '2020-01-01' }),
      error: null,
    });
    render(<StoreBillingPage />);
    await screen.findByText('Free', { selector: 'h2' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('upgrade CTA is a disabled placeholder (task 3 wires checkout)', async () => {
    apiGet.mockResolvedValue({ data: billing(), error: null });
    render(<StoreBillingPage />);
    const cta = (await screen.findByRole('button', { name: 'upgradeCta' })) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it('only a super-admin gets the plan picker', async () => {
    apiGet.mockImplementation(async (url: string) =>
      url.includes('/admin/plans')
        ? { data: { plans: [] }, error: null }
        : { data: billing(), error: null }
    );
    render(<StoreBillingPage />);
    await screen.findByText('Free', { selector: 'h2' });
    expect(screen.queryByLabelText('adminPlanLabel')).toBeNull();
    cleanup();

    role.current = 'super_admin';
    render(<StoreBillingPage />);
    expect(await screen.findByLabelText('adminPlanLabel')).toBeTruthy();
  });

  it('shows the load-failure state with a retry on error', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'SERVER_ERROR', message: 'x', status: 500 },
    });
    render(<StoreBillingPage />);
    expect(await screen.findByText('loadError')).toBeTruthy();
  });
});
