// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { api, search } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
  search: { value: '' },
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'ar',
  useTranslations: () => (k: string) => k,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 's1' }),
  useSearchParams: () => new URLSearchParams(search.value),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('@ebda/ui', async () => {
  const real = await vi.importActual<Record<string, unknown>>('@ebda/ui');
  return { ...real, useToast: () => ({ success: vi.fn(), error: vi.fn() }) };
});
vi.mock('../../apps/admin/src/i18n/useT', () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('../../apps/admin/src/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../apps/admin/src/lib/api', () => ({
  apiGet: api.get,
  apiPost: api.post,
  apiRequest: api.request,
}));
vi.mock('../../apps/admin/src/components/billing/EbdaBillingReceipt', () => ({
  EbdaBillingReceipt: ({ charge }: { charge: { id: string } }) => (
    <div data-testid="receipt-paper">{charge.id}</div>
  ),
}));

import AddonsPage from '../../apps/admin/src/app/stores/[id]/billing/addons/page';
import { FeatureUpgradeGate } from '../../apps/admin/src/components/FeatureUpgradeGate';
import { PlanLockedCard } from '../../apps/admin/src/components/PlanLockedCard';
import { planGateView } from '../../apps/admin/src/lib/plan-gate-registry';

const row = (sku: string, state: string, extra: Record<string, unknown> = {}) => ({
  sku,
  kind: sku.startsWith('ai:') ? 'ai_topup' : 'feature',
  nameEn: sku,
  nameAr: sku,
  descEn: `what ${sku} does`,
  descAr: `بيعمل ايه ${sku}`,
  previewImage: null,
  priceMinor: 9900,
  state,
  includedInPlan: state === 'included' || state === 'granted',
  active: null,
  ...extra,
});
const listing = (addons: unknown[]) => ({
  data: {
    cardAvailable: true,
    termDays: 30,
    addons,
    ai: { baseCap: 150, extra: 0, cap: 150, used: 0, remaining: 150 },
  },
});

beforeEach(() => {
  search.value = '';
  api.get.mockReset();
  api.post.mockReset();
  api.request.mockReset();
  let n = 0;
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: vi.fn(() => `key-${++n}`) },
    configurable: true,
  });
});
afterEach(() => cleanup());

function mockGets(addons: unknown[], history: unknown[] = []) {
  api.get.mockImplementation(async (url: string) =>
    url.endsWith('/history') ? { data: { items: history } } : listing(addons)
  );
}

describe('Add-ons page', () => {
  it('shows description and a state badge per add-on, with Buy only where it can be bought', async () => {
    mockGets([
      row('feature:floating_widget', 'available'),
      row('feature:loyalty', 'pending_payment'),
      row('feature:affiliate', 'included'),
      row('feature:upsell_crosssell', 'failed'),
    ]);
    render(<AddonsPage />);
    await screen.findByTestId('addon-feature:floating_widget');
    expect(screen.getByText('بيعمل ايه feature:floating_widget')).toBeTruthy();
    const states = (sku: string) => screen.getByTestId(`addon-${sku}`).getAttribute('data-state');
    expect(states('feature:loyalty')).toBe('pending_payment');
    const buyCount = (sku: string) =>
      screen.getByTestId(`addon-${sku}`).querySelectorAll('button').length;
    expect(buyCount('feature:floating_widget')).toBe(1);
    expect(buyCount('feature:loyalty')).toBe(0); // pending: never a second purchase
    expect(buyCount('feature:affiliate')).toBe(0); // included in plan
    expect(buyCount('feature:upsell_crosssell')).toBe(1); // failed: try again
    expect(screen.getByTestId('addon-instapay-note')).toBeTruthy();
  });

  it('renewing: Stop renewing is offered, Buy is not; cancelled_at_period_end offers Resume', async () => {
    const active = { endsAt: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false };
    mockGets([
      row('feature:loyalty', 'renewing', { active }),
      row('feature:affiliate', 'cancelled_at_period_end', {
        active: { ...active, cancelAtPeriodEnd: true },
      }),
    ]);
    render(<AddonsPage />);
    await screen.findByTestId('addon-feature:loyalty');
    expect(screen.getByTestId('addon-feature:loyalty').textContent).toContain('cancel');
    expect(screen.getByTestId('addon-feature:loyalty').textContent).not.toContain('buy');
    expect(screen.getByTestId('addon-feature:affiliate').textContent).toContain('resume');
  });

  it('double click on "Yes, charge" sends ONE checkout, with the one key minted for the dialog', async () => {
    mockGets([row('feature:floating_widget', 'available')]);
    api.post.mockResolvedValue({
      data: {
        sku: 'feature:floating_widget',
        nameEn: 'x',
        nameAr: 'x',
        vatMinor: 0,
        totalMinor: 9900,
        termDays: 30,
        renews: true,
        renewalMinor: 9900,
        renewsEveryDays: 30,
        confirmToken: 'preview-1',
      },
    });
    let release!: () => void;
    api.request.mockImplementation(
      () => new Promise(res => (release = () => res({ error: { message: 'stop' } })))
    );
    render(<AddonsPage />);
    const card = await screen.findByTestId('addon-feature:floating_widget');
    fireEvent.click(card.querySelector('button')!);
    const yes = await screen.findByText(/confirmYes/);
    fireEvent.click(yes);
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(api.request).toHaveBeenCalledTimes(1);
    const init = api.request.mock.calls[0][1];
    expect(init.headers['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(init.body)).toEqual({
      sku: 'feature:floating_widget',
      confirmToken: 'preview-1',
    });
    await act(async () => release());
  });

  it('back from the card page: polls the server and never turns anything on by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      search.value = 'checkout=return';
      let state = 'pending_payment';
      api.get.mockImplementation(async (url: string) =>
        url.endsWith('/history')
          ? { data: { items: [] } }
          : listing([row('feature:loyalty', state)])
      );
      render(<AddonsPage />);
      await screen.findByTestId('addon-feature:loyalty');
      expect(screen.getByRole('status').textContent).toContain('returnPending');
      expect(screen.getByTestId('addon-feature:loyalty').getAttribute('data-state')).toBe(
        'pending_payment'
      );
      state = 'renewing';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      await waitFor(() =>
        expect(screen.getByTestId('addon-feature:loyalty').getAttribute('data-state')).toBe(
          'renewing'
        )
      );
      expect(screen.getByRole('status').textContent).toContain('returnDone');
    } finally {
      vi.useRealTimers();
    }
  });

  it('history lists payments and opens a receipt for a paid one, not for a failed one', async () => {
    mockGets(
      [row('feature:loyalty', 'available')],
      [
        {
          id: 'pay-ok',
          sku: 'feature:loyalty',
          nameEn: 'L',
          nameAr: 'L',
          status: 'succeeded',
          amountMinor: 9900,
          vatMinor: 0,
          vat: null,
          termEnd: '2026-12-01T00:00:00Z',
          createdAt: '2026-11-01T00:00:00Z',
          planCode: 'addon:feature:loyalty',
        },
        {
          id: 'pay-bad',
          sku: 'feature:loyalty',
          nameEn: 'L',
          nameAr: 'L',
          status: 'failed',
          amountMinor: 9900,
          vatMinor: 0,
          vat: null,
          termEnd: null,
          createdAt: '2026-10-01T00:00:00Z',
          planCode: 'addon:feature:loyalty',
        },
      ]
    );
    render(<AddonsPage />);
    const hist = await screen.findByTestId('addon-history');
    expect(hist.querySelectorAll('li').length).toBe(2);
    expect(hist.querySelectorAll('button').length).toBe(1);
    fireEvent.click(hist.querySelector('button')!);
    expect(screen.getByTestId('receipt-paper').textContent).toBe('pay-ok');
  });

  it('?sku= scrolls the named card into view', async () => {
    search.value = 'sku=feature%3Aloyalty';
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    mockGets([row('feature:loyalty', 'available')]);
    render(<AddonsPage />);
    await screen.findByTestId('addon-feature:loyalty');
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });
});

describe('locked screens offer the buy path', () => {
  it('FeatureUpgradeGate: a sellable add-on gets "Get this add-on" -> the Add-ons page, no support mailto', () => {
    render(<FeatureUpgradeGate featureKey="loyalty" storeId="s1" />);
    const cta = screen.getByTestId('get-addon-cta');
    expect(cta.getAttribute('href')).toBe('/stores/s1/billing/addons?sku=feature%3Aloyalty');
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('FeatureUpgradeGate: a plan-only feature keeps the plan upsell and contact link', () => {
    render(<FeatureUpgradeGate featureKey="inventory.backorder" storeId="s1" />);
    expect(screen.queryByTestId('get-addon-cta')).toBeNull();
    expect(document.querySelector('a[href^="mailto:"]')).not.toBeNull();
  });

  it('PlanLockedCard: a FEATURE_DISABLED for a sellable feature shows the buy path; others do not', () => {
    render(
      <PlanLockedCard
        info={{ status: 403, code: 'FEATURE_DISABLED', details: { feature: 'floating_widget' } }}
        message=""
      />
    );
    expect(screen.getByTestId('get-addon-cta').getAttribute('href')).toBe(
      '/stores/s1/billing/addons?sku=feature%3Afloating_widget'
    );
    cleanup();
    render(
      <PlanLockedCard
        info={{ status: 403, code: 'FEATURE_DISABLED', details: { feature: 'coupons' } }}
        message=""
      />
    );
    expect(screen.queryByTestId('get-addon-cta')).toBeNull();
  });

  it('planGateView reads the API hint first, then falls back to the feature key', () => {
    const v = planGateView({
      status: 403,
      code: 'FEATURE_DISABLED',
      details: { addonSku: 'feature:affiliate' },
    });
    expect(v.addonSku).toBe('feature:affiliate');
  });
});
