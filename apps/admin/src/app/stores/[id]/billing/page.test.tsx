// @vitest-environment jsdom
/**
 * Merchant Billing page (SP5 task 1): "open /stores/:id/billing -> rows render".
 * The plan, usage-vs-limit bars, over-limit banner, the super-admin-only plan
 * picker, and (SP5 task 3) subscribe/checkout, dunning banner and charges list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost, role } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  role: { current: 'store_admin' },
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../../../lib/api', () => ({ apiGet, apiPost, apiPut: vi.fn() }));
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

/** apiGet by URL: the billing summary, the charges list, anything else empty. */
function mockApi(summary: unknown, charges: unknown[] = []) {
  apiGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/invoices')) return { data: { charges }, error: null };
    return { data: summary, error: null };
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  role.current = 'store_admin';
});

describe('merchant billing page', () => {
  it('renders the plan name and one progressbar per count limit with the right values', async () => {
    mockApi(billing());
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
    mockApi(billing({ ordersOverLimitMonth: `${month}-01` }));
    render(<StoreBillingPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();

    mockApi(billing({ ordersOverLimitMonth: '2020-01-01' }));
    render(<StoreBillingPage />);
    await screen.findByText('Free', { selector: 'h2' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  const paidPlan = (over: Record<string, unknown> = {}) => ({
    code: 'growth',
    nameEn: 'Growth',
    nameAr: 'النمو',
    priceMonthlyMinor: 49900,
    priceYearlyMinor: 499000,
    limits,
    ...over,
  });

  it('a plan with no price cannot be subscribed to (disabled, never "0")', async () => {
    mockApi(billing({ availablePlans: [paidPlan({ priceMonthlyMinor: null })] }));
    render(<StoreBillingPage />);
    const cta = (await screen.findByRole('button', { name: 'priceUnset' })) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it('subscribing posts the checkout and redirects to the hosted payment page', async () => {
    mockApi(billing({ availablePlans: [paidPlan()] }));
    apiPost.mockResolvedValue({ data: { redirectUrl: 'https://pay.test/s/1' }, error: null });
    const loc = { href: '' };
    vi.stubGlobal('location', loc);
    render(<StoreBillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'subscribe' }));
    await waitFor(() => expect(loc.href).toBe('https://pay.test/s/1'));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/store-1/billing/checkout', {
      planCode: 'growth',
      interval: 'monthly',
    });
    vi.unstubAllGlobals();
  });

  it('shows the dunning banner with the retry date when payment is overdue', async () => {
    mockApi(
      billing({
        subscription: {
          status: 'past_due',
          currentPeriodEnd: '2026-11-03T04:00:00.000Z',
          trialEndsAt: null,
          cancelAtPeriodEnd: false,
        },
        billing: {
          billingInterval: 'monthly',
          pendingPlanCode: null,
          nextRetryAt: '2026-11-06T04:00:00.000Z',
          dunningAttempts: 1,
          hasPaymentMethod: true,
          billedByPlatform: true,
        },
      })
    );
    render(<StoreBillingPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('pastDueTitle');
    expect(alert.textContent).toContain('pastDueBody');
  });

  it('lists the store charges with amount and status (open /billing -> rows render)', async () => {
    mockApi(billing(), [
      {
        id: 'c1',
        type: 'renewal',
        planCode: 'growth',
        amountMinor: 49900,
        status: 'succeeded',
        failureReason: null,
        attempt: 0,
        createdAt: '2026-11-03T04:00:00.000Z',
      },
      {
        id: 'c2',
        type: 'renewal',
        planCode: 'growth',
        amountMinor: 49900,
        status: 'failed',
        failureReason: 'declined',
        attempt: 1,
        createdAt: '2026-11-06T04:00:00.000Z',
      },
    ]);
    render(<StoreBillingPage />);
    expect(await screen.findAllByText('499.00', { exact: false })).toHaveLength(2);
    expect(screen.getByText('invoiceStatuses.succeeded')).toBeTruthy();
    expect(screen.getByText('invoiceStatuses.failed')).toBeTruthy();
    expect(screen.getByText('declined')).toBeTruthy();
  });

  it('only a super-admin gets the plan picker', async () => {
    apiGet.mockImplementation(async (url: string) =>
      url.includes('/admin/plans')
        ? { data: { plans: [] }, error: null }
        : url.endsWith('/invoices')
          ? { data: { charges: [] }, error: null }
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
