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
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../../../lib/api', () => ({ apiGet, apiPost, apiPut: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: role.current } }) }));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});
vi.mock('@ebda/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Select: ({ label }: { label: string }) => <select aria-label={label} />,
  Input: ({
    label,
    error,
    ...p
  }: { label?: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={p.id}>{label}</label>
      <input {...p} />
      {error && <p>{error}</p>}
    </div>
  ),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import StoreBillingPage from './page';
import { billingFixture } from '../../../../components/billing/fixtures';

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
  maxStores: 1,
  brandingRemoval: false,
  apiAccess: false,
  wholesalePricing: false,
  analyticsTier: 'basic',
  supportTier: 'email',
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
function mockApi(summary: unknown, charges: unknown[] = [], claims: unknown[] = []) {
  apiGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/invoices')) return { data: { charges }, error: null };
    if (url.endsWith('/payment-claims')) return { data: { claims }, error: null };
    return { data: summary, error: null };
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
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

  it('QA-STOR-1: storage shows "<used MB> of <limit>" from the usage counter, like the other limits', async () => {
    mockApi(
      billing({
        usage: {
          maxProducts: 45,
          maxStaff: 1,
          maxOrdersPerMonth: 120,
          maxStorageMb: 120,
          customDomain: 0,
        },
      })
    );
    render(<StoreBillingPage />);
    await screen.findByText('Free', { selector: 'h2' });
    const storage = screen
      .getAllByRole('progressbar')
      .find(b => b.getAttribute('aria-label') === 'maxStorageMb')!;
    expect(storage.getAttribute('aria-valuenow')).toBe('120');
    expect(storage.getAttribute('aria-valuemax')).toBe('500');
    expect(screen.queryByTestId('storage-usage-unknown')).toBeNull();
  });

  it('QA-STOR-1: an unreadable storage counter says "not known right now", never 0', async () => {
    mockApi(billing());
    render(<StoreBillingPage />);
    const row = await screen.findByTestId('storage-usage-unknown');
    expect(row.textContent).toContain('storageUnknown');
    expect(row.textContent).toContain('500');
    expect(
      screen.getAllByRole('progressbar').find(b => b.getAttribute('aria-label') === 'maxStorageMb')
    ).toBeUndefined();
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
    mockApi(
      billing({
        availablePlans: [paidPlan({ priceMonthlyMinor: null })],
        billing: billingFixture({ trialCardMode: 'card_on_file' }),
      })
    );
    render(<StoreBillingPage />);
    const cta = (await screen.findByRole('button', { name: 'priceUnset' })) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it('InstaPay-only (default): no card subscribe buttons, InstaPay copy instead', async () => {
    mockApi(
      billing({
        availablePlans: [paidPlan()],
        billing: billingFixture({
          trialCardMode: 'pay_at_trial_end',
          hasPaymentMethod: false,
          card: null,
        }),
      })
    );
    render(<StoreBillingPage />);
    expect(await screen.findByText('subscribeBodyInstapay')).toBeTruthy();
    expect(screen.queryByText('subscribeBody')).toBeNull();
    expect(screen.queryByRole('button', { name: 'subscribe' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'pay.addCard' })).toBeNull();
  });

  it('subscribing posts the checkout and redirects to the hosted payment page', async () => {
    mockApi(
      billing({
        availablePlans: [paidPlan()],
        billing: billingFixture({ trialCardMode: 'card_on_file' }),
      })
    );
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

describe('signup funnel: plan, payment method, notices, go live', () => {
  const instapayChosen = billingFixture({
    trialCardMode: 'pay_at_trial_end',
    billingMethod: 'instapay',
    billingInterval: 'yearly',
    instapay: {
      available: true,
      handle: 'ebda@instapay',
      reference: 'EBD-7K2Q',
      amountMinor: 3141000,
      pendingClaims: 0,
    },
  });
  const plans = [
    {
      code: 'growth',
      nameEn: 'Growth',
      nameAr: 'النمو',
      priceMonthlyMinor: 349000,
      priceYearlyMinor: 3141000,
      limits,
    },
  ];
  const trialing = {
    status: 'trialing',
    currentPeriodEnd: null,
    trialEndsAt: '2026-11-20T00:00:00.000Z',
    cancelAtPeriodEnd: false,
  };

  it('awaiting payment: no "renews on" date for a plan nobody has paid for', async () => {
    mockApi(
      billing({
        subscription: {
          status: 'active',
          currentPeriodEnd: '2027-11-12T00:00:00.000Z',
          trialEndsAt: null,
          cancelAtPeriodEnd: false,
        },
        availablePlans: plans,
        billing: {
          ...instapayChosen,
          nextCharge: { at: '2026-11-20T00:00:00.000Z', planCode: 'growth', amountMinor: 3141000 },
        },
      })
    );
    render(<StoreBillingPage />);
    expect((await screen.findAllByText('status.awaiting_payment')).length).toBeGreaterThan(0);
    expect(screen.queryByText('renewsOn')).toBeNull();
  });

  it('Plan & trial: trial end, chosen plan + interval, next charge with amount and plan', async () => {
    mockApi(
      billing({
        subscription: trialing,
        availablePlans: plans,
        billing: {
          ...instapayChosen,
          nextCharge: { at: '2026-11-20T00:00:00.000Z', planCode: 'growth', amountMinor: 3141000 },
        },
      })
    );
    render(<StoreBillingPage />);
    expect(await screen.findByText('trial.title')).toBeTruthy();
    expect(screen.getByText('Growth · intervalYearly')).toBeTruthy();
    // InstaPay: a payment is DUE (never "next charge"), with the interval next to the amount (BILLING-NONE-COPY-1).
    expect(
      screen.getByText(
        'trial.instapayDueLine:{"amount":"EGP 31,410.00","interval":"intervalYearly","plan":"Growth","date":"20 November 2026"}'
      )
    ).toBeTruthy();
    expect(screen.getByText('trial.returnsToFree')).toBeTruthy();
    expect(screen.queryByText('trial.nextCharge')).toBeNull();
    expect(screen.getAllByText('status.trialing').length).toBeGreaterThan(0);
  });

  it('BILLING_PROVIDER=none: no screen calls the trial-end payment a (card) next charge', async () => {
    mockApi(
      billing({
        subscription: trialing,
        availablePlans: plans,
        billing: {
          ...billingFixture(),
          billingMethod: null,
          cardBilling: false,
          nextCharge: { at: '2026-11-20T00:00:00.000Z', planCode: 'growth', amountMinor: 3141000 },
        },
      })
    );
    render(<StoreBillingPage />);
    expect(await screen.findByText('trial.instapayDue')).toBeTruthy();
    expect(screen.getByText(/^trial\.instapayDueLine:/)).toBeTruthy();
    expect(screen.getByText('trial.returnsToFree')).toBeTruthy();
    expect(screen.queryByText('trial.nextCharge')).toBeNull();
    expect(screen.queryByText(/^trial\.nextChargeLine/)).toBeNull();
  });

  it('a card store still says next charge, now with the interval beside the amount', async () => {
    mockApi(
      billing({
        subscription: trialing,
        availablePlans: plans,
        billing: {
          ...billingFixture(),
          billingMethod: 'card',
          cardBilling: true,
          billingInterval: 'monthly',
          nextCharge: { at: '2026-11-20T00:00:00.000Z', planCode: 'growth', amountMinor: 349000 },
        },
      })
    );
    render(<StoreBillingPage />);
    expect(await screen.findByText('trial.nextCharge')).toBeTruthy();
    expect(screen.getByText(/^trial\.nextChargeLine:.*"interval":"intervalMonthly"/)).toBeTruthy();
  });

  it('BILLING-INTERVAL-PENDING-1: renewal quote keeps the current interval; the pending switch is its own line', async () => {
    mockApi(
      billing({
        subscription: trialing,
        availablePlans: plans,
        billing: {
          ...billingFixture(),
          billingMethod: null,
          cardBilling: false,
          billingInterval: 'yearly',
          pendingBillingInterval: 'monthly',
          nextCharge: { at: '2027-11-12T00:00:00.000Z', planCode: 'growth', amountMinor: 3141000 },
        },
      })
    );
    render(<StoreBillingPage />);
    expect(
      await screen.findByText(/^trial\.instapayDueLine:.*"interval":"intervalYearly"/)
    ).toBeTruthy();
    expect(
      screen.getByText(/^trial\.switchingInterval:.*"interval":"intervalMonthly"/)
    ).toBeTruthy();
  });

  it('card on file: shows •••• 4242 and Replace card starts a billing-origin card setup', async () => {
    mockApi(
      billing({
        subscription: trialing,
        billing: billingFixture({
          hasPaymentMethod: true,
          billingMethod: 'card',
          card: { last4: '4242', brand: 'visa', savedAt: '2026-11-05T00:00:00.000Z' },
        }),
      })
    );
    apiPost.mockResolvedValue({ data: { redirectUrl: 'https://pay.test/card/9' }, error: null });
    const loc = { href: '', search: '' };
    vi.stubGlobal('location', loc);
    render(<StoreBillingPage />);
    expect(await screen.findByText('•••• 4242 visa')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'pay.replaceCard' }));
    await waitFor(() => expect(loc.href).toBe('https://pay.test/card/9'));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/store-1/billing/card-setup', {
      from: 'billing',
    });
  });

  const instapayClaim = {
    id: 'cl1',
    planCode: 'growth',
    billingInterval: 'yearly',
    amountMinor: 3141000,
    method: 'instapay',
    paymentReference: 'EBD-7K2Q',
    status: 'pending',
    reviewNote: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    reviewedAt: null,
    receipt: { fields: { reference: '123456789012' } },
  };

  it('InstaPay: shows the reference and the receipt upload that says the Ebda team reviews', async () => {
    mockApi(billing({ subscription: trialing, billing: instapayChosen }), [], [instapayClaim]);
    render(<StoreBillingPage />);
    expect(await screen.findByText('EBD-7K2Q')).toBeTruthy();
    expect(screen.getByText('123456789012')).toBeTruthy();
    expect(screen.getByText('claims.status.pending')).toBeTruthy();
    expect(screen.getByTestId('receipt-reviewer-note').textContent).toBe('pay.reviewerNote');
    expect(screen.getByLabelText('file')).toBeTruthy();
    // The old typed-reference box is gone (the endpoint answers 410).
    expect(screen.queryByLabelText('pay.payerRef')).toBeNull();
  });

  it('a rejected claim shows its reason and an "upload the right receipt" action', async () => {
    mockApi(
      billing({ subscription: trialing, billing: instapayChosen }),
      [],
      [{ ...instapayClaim, status: 'rejected', reviewNote: 'Wrong amount' }]
    );
    render(<StoreBillingPage />);
    expect(await screen.findByText('Wrong amount')).toBeTruthy();
    const link = screen.getByText('claims.uploadRight');
    expect(link.getAttribute('href')).toBe('#instapay-upload');
  });

  it('InstaPay merchant: plan buttons and cancel are offered (not only for card holders)', async () => {
    mockApi(
      billing({
        subscription: { ...trialing, status: 'active' },
        availablePlans: [
          { ...plans[0], code: 'basic', nameEn: 'Basic' },
          { ...plans[0], code: 'growth' },
        ],
        plan: { code: 'basic', nameEn: 'Basic', nameAr: 'أساسي', subscribedPlanCode: 'basic' },
        billing: { ...instapayChosen, pendingPlanCode: null },
      })
    );
    apiPost.mockImplementation(async (url: string) => ({
      data: url.endsWith('/instapay-plan')
        ? {
            handle: 'ebda@instapay',
            reference: 'EBD-7K2Q',
            planCode: 'growth',
            interval: 'monthly',
            amountMinor: 349000,
          }
        : {},
      error: null,
    }));
    render(<StoreBillingPage />);
    const choose = await screen.findByRole('button', { name: 'chooseThisPlan' });
    expect(screen.getByRole('button', { name: 'cancelPlan' })).toBeTruthy();
    fireEvent.click(choose);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/store-1/billing/instapay-plan', {
        planCode: 'growth',
        interval: 'monthly',
      })
    );
    expect(await screen.findByTestId('instapay-quote')).toBeTruthy();
    expect(document.getElementById('plans')).toBeTruthy();
  });

  it('canceled store: "subscription ended" copy, never "Free plan limits apply", plan picker shown', async () => {
    mockApi(
      billing({
        subscription: { ...trialing, status: 'canceled', trialEndsAt: null },
        availablePlans: plans,
        billing: { ...instapayChosen, pendingPlanCode: null },
      })
    );
    render(<StoreBillingPage />);
    expect(await screen.findByText('canceledTitle')).toBeTruthy();
    expect(screen.getByText('canceledBody')).toBeTruthy();
    expect(screen.queryByText(/Free plan/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'chooseThisPlan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cancelPlan' })).toBeNull();
  });

  it('payOnStore: tells the owner to pay on the main store, links to it, hides pay/plan actions', async () => {
    mockApi(
      billing({
        payOnStore: 'main-store',
        subscription: { ...trialing, status: 'active' },
        availablePlans: plans,
        billing: { ...instapayChosen, pendingPlanCode: null },
      })
    );
    render(<StoreBillingPage />);
    expect(await screen.findByText('payOnStoreBody')).toBeTruthy();
    expect(screen.getByText('payOnStoreLink').getAttribute('href')).toBe(
      '/stores/main-store/billing'
    );
    expect(screen.queryByRole('button', { name: 'chooseThisPlan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'cancelPlan' })).toBeNull();
    expect(screen.queryByLabelText('file')).toBeNull();
  });

  it('unpaid suspension: an alert with the pay instructions and the support WhatsApp link', async () => {
    mockApi(
      billing({
        storeStatus: 'suspended',
        billing: billingFixture({
          suspension: { reason: 'unpaid', at: '2026-11-20T00:00:00.000Z' },
          supportWhatsappUrl: 'https://wa.me/201000000000',
        }),
      })
    );
    render(<StoreBillingPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('unpaidTitle');
    expect(alert.textContent).toContain('unpaidBody');
    expect(screen.getByRole('link', { name: 'whatsapp' }).getAttribute('href')).toBe(
      'https://wa.me/201000000000'
    );
  });

  it('no support WhatsApp configured: the notice links the support email, never an empty wa.me', async () => {
    mockApi(
      billing({
        storeStatus: 'suspended',
        billing: billingFixture({
          suspension: { reason: 'unpaid', at: '2026-11-20T00:00:00.000Z' },
          supportWhatsappUrl: null,
          supportEmail: 'ahlan@ebda.app',
        }),
      })
    );
    render(<StoreBillingPage />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('link', { name: 'whatsapp' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'email:{"email":"ahlan@ebda.app"}' }).getAttribute('href')
    ).toBe('mailto:ahlan@ebda.app');
    expect(document.querySelector('a[href*="wa.me"]')).toBeNull();
  });

  it('invoices: a VAT line + Ebda TRN only on a charge that carried Ebda VAT', async () => {
    mockApi(billing({}), [
      {
        id: 'c1',
        type: 'renewal',
        planCode: 'growth',
        amountMinor: 397860,
        vatMinor: 48860,
        vat: {
          netMinor: 349000,
          vatMinor: 48860,
          rateBps: 1400,
          mode: 'exclusive',
          trn: '123456789',
          legalName: 'Ebda AI Studio',
        },
        status: 'succeeded',
        failureReason: null,
        attempt: 0,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
      {
        id: 'c0',
        type: 'checkout',
        planCode: 'growth',
        amountMinor: 349000,
        vatMinor: 0,
        vat: null,
        status: 'succeeded',
        failureReason: null,
        attempt: 0,
        createdAt: '2026-10-20T00:00:00.000Z',
      },
    ]);
    render(<StoreBillingPage />);
    expect(await screen.findByText(/invoiceVat:\{"rate":14,"vat":"EGP 488.60"\}/)).toBeTruthy();
    expect(screen.getAllByText(/invoiceVat/)).toHaveLength(1);
    expect(screen.getByTestId('tax-invoice-seller').textContent).toContain('123456789');
  });

  it('over-store-limit suspension is a read-only notice that points to the plans', async () => {
    mockApi(
      billing({
        billing: billingFixture({
          suspension: { reason: 'over_store_limit', at: '2026-11-20T00:00:00.000Z' },
        }),
      })
    );
    render(<StoreBillingPage />);
    expect((await screen.findByRole('alert')).textContent).toContain('overLimitTitle');
    expect(screen.getByRole('link', { name: 'seePlans' })).toBeTruthy();
  });

  it('due soon with a card on file names the card and the date, calmly (not an alert)', async () => {
    mockApi(
      billing({
        billing: billingFixture({
          hasPaymentMethod: true,
          billingMethod: 'card',
          card: { last4: '4242', brand: 'visa', savedAt: null },
          dueSoon: { dueAt: '2026-11-20T00:00:00.000Z', daysLeft: 3 },
        }),
      })
    );
    render(<StoreBillingPage />);
    const note = await screen.findByRole('status');
    expect(note.textContent).toContain(
      'chargeSoon:{"card":"•••• 4242 visa","date":"20 November 2026"}'
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Go live: shown only for an inactive store; a 402 shows its localized message', async () => {
    mockApi(billing({ storeStatus: 'inactive', billing: billingFixture() }));
    apiPost.mockResolvedValue({
      data: null,
      error: {
        code: 'PAYMENT_METHOD_REQUIRED',
        message: 'Add a payment method first',
        status: 402,
      },
    });
    render(<StoreBillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'goLive.cta' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Add a payment method first');
    expect(apiPost).toHaveBeenCalledWith('/api/v1/onboarding/stores/store-1/go-live');
    cleanup();

    mockApi(billing({ storeStatus: 'active', billing: billingFixture() }));
    render(<StoreBillingPage />);
    await screen.findByText('trial.title');
    expect(screen.queryByRole('button', { name: 'goLive.cta' })).toBeNull();
  });

  it('charges list labels card_setup ("nothing charged") and manual_payment', async () => {
    mockApi(billing(), [
      {
        id: 'c1',
        type: 'card_setup',
        planCode: null,
        amountMinor: 0,
        status: 'succeeded',
        failureReason: null,
        attempt: 0,
        createdAt: '2026-11-03T04:00:00.000Z',
      },
      {
        id: 'c2',
        type: 'manual_payment',
        planCode: 'growth',
        amountMinor: 349000,
        status: 'succeeded',
        failureReason: null,
        attempt: 0,
        createdAt: '2026-11-04T04:00:00.000Z',
      },
    ]);
    render(<StoreBillingPage />);
    expect(await screen.findByText('invoiceTypes.card_setup')).toBeTruthy();
    expect(screen.getByText(/invoiceTypes\.manual_payment/)).toBeTruthy();
  });

  it('back from the card page (stub): needs the simulate button, then polls until the card is saved', async () => {
    window.history.replaceState(
      null,
      '',
      '/stores/store-1/billing?card=return&stub=1&merchantOrderId=22222222-2222-2222-2222-222222222222'
    );
    let saved = false;
    apiGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/invoices')) return { data: { charges: [] }, error: null };
      if (url.endsWith('/payment-claims')) return { data: { claims: [] }, error: null };
      return {
        data: billing({
          subscription: trialing,
          billing: billingFixture(
            saved
              ? {
                  hasPaymentMethod: true,
                  billingMethod: 'card',
                  card: { last4: '4242', brand: 'visa', savedAt: null },
                }
              : {}
          ),
        }),
        error: null,
      };
    });
    apiPost.mockImplementation(async () => {
      saved = true;
      return { data: {}, error: null };
    });
    render(<StoreBillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'pay.stubSaved' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/store-1/billing/checkout/stub-confirm', {
        merchantOrderId: '22222222-2222-2222-2222-222222222222',
        outcome: 'success',
      })
    );
    expect(await screen.findByText('pay.returnOk')).toBeTruthy();
    expect(await screen.findByText('•••• 4242 visa')).toBeTruthy();
  });
});
