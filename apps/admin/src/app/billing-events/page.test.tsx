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
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => confirmMock }));
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
vi.mock('@ebda/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
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
  Select: ({
    label,
    options,
    ...p
  }: {
    label?: string;
    options: { value: string; label: string }[];
  } & React.SelectHTMLAttributes<HTMLSelectElement>) => (
    <label>
      {label}
      <select {...p}>
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  ),
  Modal: ({ children, title }: { children: React.ReactNode; title?: string }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}));

import BillingEventsPage from './page';
import { addPeriod } from './_components/ManualPaymentForm';

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
  vi.useRealTimers();
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
    confirmMock.mockResolvedValue(true);
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

const sub = (over: Record<string, unknown> = {}) => ({
  storeId: 's9',
  storeName: 'Nile Textiles',
  storeSlug: 'nile',
  storeStatus: 'active',
  planCode: 'growth',
  chosenPlanCode: 'business',
  billingInterval: 'yearly',
  status: 'trialing',
  trialEndsAt: '2026-11-20T00:00:00.000Z',
  card: null,
  provider: 'kashier',
  billingMethod: 'instapay',
  paymentReference: 'EBD-7K2Q',
  suspendedReason: null,
  dunningAttempts: 0,
  nextRetryAt: null,
  currentPeriodEnd: null,
  nextCharge: { at: '2026-11-20T00:00:00.000Z', planCode: 'business', amountMinor: 8991000 },
  ...over,
});

/** apiGet by URL for the three tabs. */
function mockTabs(subs: unknown[] = [sub()], claims: unknown[] = []) {
  apiGet.mockImplementation(async (url: string) => {
    if (url.includes('/billing/subscriptions'))
      return { data: { subscriptions: subs }, error: null };
    if (url.includes('/billing/claims')) return { data: { claims }, error: null };
    return { data: { events: [] }, error: null };
  });
}
const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('billing ledger: signup-funnel additions', () => {
  it('the type filter offers card_setup and manual_payment and sends them as the API filter', async () => {
    apiGet.mockResolvedValue({ data: { events: [] }, error: null });
    render(<BillingEventsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'types.card_setup' }));
    await waitFor(() =>
      expect(apiGet.mock.calls.some(c => String(c[0]).includes('type=card_setup'))).toBe(true)
    );
    fireEvent.click(screen.getByRole('button', { name: 'types.manual_payment' }));
    await waitFor(() =>
      expect(apiGet.mock.calls.some(c => String(c[0]).includes('type=manual_payment'))).toBe(true)
    );
  });

  it('Subscriptions tab lists stores and filters by view (due / overdue / suspended)', async () => {
    mockTabs();
    render(<BillingEventsPage />);
    openTab('tabs.subscriptions');
    expect((await screen.findAllByText('Nile Textiles')).length).toBeGreaterThan(0);
    expect(apiGet).toHaveBeenCalledWith('/api/v1/admin/billing/subscriptions');
    fireEvent.click(screen.getByRole('button', { name: 'views.overdue' }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith('/api/v1/admin/billing/subscriptions?view=overdue')
    );
    fireEvent.click(screen.getByRole('button', { name: 'views.due' }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith('/api/v1/admin/billing/subscriptions?view=due')
    );
    fireEvent.click(screen.getByRole('button', { name: 'views.suspended' }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith('/api/v1/admin/billing/subscriptions?view=suspended')
    );
  });

  it('Subscriptions: an outage is a failure state, not "no subscriptions"', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'SERVER_ERROR', message: 'x', status: 500 },
    });
    render(<BillingEventsPage />);
    openTab('tabs.subscriptions');
    expect((await screen.findByRole('alert')).textContent).toBe('failedToLoad');
  });

  it('manual payment: amount is converted to piastres by string parsing, never float math', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
    mockTabs();
    apiPost.mockResolvedValue({ data: { duplicate: false, billingEventId: 'b1' }, error: null });
    render(<BillingEventsPage />);
    openTab('tabs.subscriptions');
    fireEvent.click((await screen.findAllByRole('button', { name: 'record' }))[0]);
    // Prefilled from the row: chosen plan, interval, next-charge amount, InstaPay.
    expect((screen.getByLabelText('amount') as HTMLInputElement).value).toBe('89910.00');
    expect((screen.getByLabelText('plan') as HTMLSelectElement).value).toBe('business');
    expect((screen.getByLabelText('interval') as HTMLSelectElement).value).toBe('yearly');
    // No period inputs by default: the server applies its rule (no paid days burned).
    expect(screen.queryByLabelText('periodEnd')).toBeNull();
    expect(screen.getByTestId('mp-period-auto')).toBeTruthy();

    const amount = screen.getByLabelText('amount');
    fireEvent.change(screen.getByLabelText('reference'), { target: { value: 'IPN-1' } });
    fireEvent.change(amount, { target: { value: '1.999' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    expect(await screen.findByText('amountInvalid')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();

    // 0.29 * 100 is 28.999999999999996 in floats; the API must get exactly 29.
    fireEvent.change(amount, { target: { value: '0.29' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/stores/s9/manual-payment', {
      planCode: 'business',
      interval: 'yearly',
      amountMinor: 29,
      method: 'instapay',
      reference: 'IPN-1',
      paidAt: '2026-11-05T00:00:00.000Z',
    });
    expect(await screen.findByText('manual.recorded')).toBeTruthy();
  });

  it('manual payment: "Edit period" sends BOTH period dates; the suggestion is fetched, not guessed', async () => {
    mockTabs();
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('/manual-payment/suggest'))
        return {
          data: { periodStart: '2026-12-01T00:00:00.000Z', periodEnd: '2027-12-01T00:00:00.000Z' },
          error: null,
        };
      if (url.includes('/billing/subscriptions'))
        return { data: { subscriptions: [sub()] }, error: null };
      return { data: { events: [], claims: [] }, error: null };
    });
    apiPost.mockResolvedValue({ data: { duplicate: false }, error: null });
    render(<BillingEventsPage />);
    openTab('tabs.subscriptions');
    fireEvent.click((await screen.findAllByRole('button', { name: 'record' }))[0]);
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/api/v1/admin/stores/s9/manual-payment/suggest?interval=yearly'
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'editPeriod' }));
    expect((screen.getByLabelText('periodStart') as HTMLInputElement).value).toBe('2026-12-01');
    fireEvent.change(screen.getByLabelText('reference'), { target: { value: 'IPN-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).toMatchObject({
      periodStart: '2026-12-01T00:00:00.000Z',
      periodEnd: '2027-12-01T00:00:00.000Z',
    });
  });

  it('BILLING-INTERVAL-PENDING-1: the table shows the pending switch and the record dialog defaults to it', async () => {
    mockTabs([sub({ billingInterval: 'yearly', pendingBillingInterval: 'monthly' })]);
    apiGet.mockImplementation(async (url: string) => {
      if (url.includes('/manual-payment/suggest'))
        return { data: { periodStart: null, periodEnd: null }, error: null };
      if (url.includes('/billing/subscriptions'))
        return {
          data: {
            subscriptions: [sub({ billingInterval: 'yearly', pendingBillingInterval: 'monthly' })],
          },
          error: null,
        };
      return { data: { events: [], claims: [] }, error: null };
    });
    render(<BillingEventsPage />);
    openTab('tabs.subscriptions');
    expect(await screen.findByText(/switchingTo/)).toBeTruthy();
    fireEvent.click((await screen.findAllByRole('button', { name: 'record' }))[0]);
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/api/v1/admin/stores/s9/manual-payment/suggest?interval=monthly'
      )
    );
  });

  it('BILLING-AMOUNT-GUARD-1: an AMOUNT_MISMATCH shows the expected amount and resubmits with the reason', async () => {
    mockTabs();
    apiPost
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: 'AMOUNT_MISMATCH',
          message: 'x',
          status: 409,
          details: { expectedAmountMinor: 999000, amountMinor: 1000 },
        },
      })
      .mockResolvedValueOnce({ data: { duplicate: false }, error: null });
    render(<BillingEventsPage />);
    openTab('tabs.subscriptions');
    fireEvent.click((await screen.findAllByRole('button', { name: 'record' }))[0]);
    fireEvent.change(screen.getByLabelText('reference'), { target: { value: 'IPN-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    expect(await screen.findByText(/^amountMismatch/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('overrideReason'), {
      target: { value: 'partner discount' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost.mock.calls[1][1]).toMatchObject({ overrideAmountReason: 'partner discount' });
    expect(apiPost.mock.calls[0][1]).not.toHaveProperty('overrideAmountReason');
  });

  it('manual payment: a 409 REFERENCE_USED_ELSEWHERE explains the voided-payment path', async () => {
    mockTabs();
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'REFERENCE_USED_ELSEWHERE', message: 'x', status: 409 },
    });
    render(<BillingEventsPage />);
    openTab('tabs.subscriptions');
    fireEvent.click((await screen.findAllByRole('button', { name: 'record' }))[0]);
    fireEvent.change(screen.getByLabelText('reference'), { target: { value: 'IPN-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    expect((await screen.findByRole('alert')).textContent).toBe('referenceUsedElsewhere');
  });

  it('manual payment: a repeated reference reports "duplicate" instead of success', async () => {
    mockTabs();
    apiPost.mockResolvedValue({ data: { duplicate: true, billingEventId: 'b1' }, error: null });
    render(<BillingEventsPage />);
    openTab('tabs.subscriptions');
    fireEvent.click((await screen.findAllByRole('button', { name: 'record' }))[0]);
    fireEvent.change(screen.getByLabelText('reference'), { target: { value: 'IPN-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    expect(await screen.findByText('manual.duplicate')).toBeTruthy();
    expect(screen.queryByText('manual.recorded')).toBeNull();
  });

  const claim = {
    id: 'cl1',
    storeId: 's9',
    storeName: 'Nile Textiles',
    storeSlug: 'nile',
    storeStatus: 'suspended',
    planCode: 'growth',
    billingInterval: 'monthly',
    amountMinor: 349000,
    method: 'instapay',
    paymentReference: 'EBD-7K2Q',
    payerReference: 'IPN-99887766',
    proofUrl: null,
    status: 'pending',
    createdAt: '2026-11-04T00:00:00.000Z',
  };

  it('Payment claims: Confirm & activate opens the form prefilled from the claim (incl. claimId)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-31T10:00:00.000Z'));
    mockTabs([], [claim]);
    apiPost.mockResolvedValue({ data: { duplicate: false }, error: null });
    render(<BillingEventsPage />);
    openTab('tabs.claims');
    expect(apiGet).toHaveBeenCalledWith('/api/v1/admin/billing/claims?status=pending');
    fireEvent.click((await screen.findAllByRole('button', { name: 'confirm' }))[0]);
    expect((screen.getByLabelText('reference') as HTMLInputElement).value).toBe('IPN-99887766');
    expect((screen.getByLabelText('amount') as HTMLInputElement).value).toBe('3490.00');
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).toMatchObject({
      claimId: 'cl1',
      method: 'instapay',
      amountMinor: 349000,
      reference: 'IPN-99887766',
      planCode: 'growth',
      interval: 'monthly',
    });
  });

  it('Payment claims: Reject needs a note, then posts store + note', async () => {
    mockTabs([], [claim]);
    apiPost.mockResolvedValue({ data: {}, error: null });
    render(<BillingEventsPage />);
    openTab('tabs.claims');
    fireEvent.click((await screen.findAllByRole('button', { name: 'reject' }))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'rejectSubmit' }));
    expect(await screen.findByText('noteRequired')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('note'), { target: { value: 'Amount does not match' } });
    fireEvent.click(screen.getByRole('button', { name: 'rejectSubmit' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/billing/claims/cl1/reject', {
        storeId: 's9',
        note: 'Amount does not match',
      })
    );
  });

  it('addPeriod clamps month ends and handles years', () => {
    expect(addPeriod('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(addPeriod('2028-01-31', 'monthly')).toBe('2028-02-29');
    expect(addPeriod('2026-12-15', 'monthly')).toBe('2027-01-15');
    expect(addPeriod('2028-02-29', 'yearly')).toBe('2029-02-28');
  });
});
