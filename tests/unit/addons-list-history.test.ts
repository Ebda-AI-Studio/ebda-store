/**
 * Merchant add-on page data (docs/plans/2026-11-15-self-service-addons.md sections 3, 6): every state comes from the
 * ledger, a pending/failed payment never turns a feature on, cancel keeps access until the term end and then it is off,
 * history never exposes provider fields, and a super-admin grant is shown as a grant and writes no ledger row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = new Date('2026-11-15T10:00:00.000Z');
const DAY = 86_400_000;
const h = vi.hoisted(() => ({
  events: [] as Array<Record<string, any>>,
  overrides: [] as Array<{ featureKey: string }>,
  withoutAddons: {} as Record<string, boolean>,
  allFeatures: {} as Record<string, boolean>,
  created: [] as Array<Record<string, any>>,
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: async () => false,
    getStoreFeatures: async () => h.allFeatures,
    resolveWithoutAddons: async () => h.withoutAddons,
  },
}));
vi.mock('@api/lib/ai-quota', () => ({
  storeAiAllowance: async () => ({ baseCap: 150, extra: 0, cap: 150, used: 0, remaining: 150 }),
}));
vi.mock('@api/services/billing/index', () => ({
  getBillingProvider: () => ({ name: 'kashier' }),
  resolveTrialCardMode: () => 'card_on_file',
}));
vi.mock('@api/services/billing/subscription-billing.service', () => ({
  claimEvent: vi.fn(),
  markFailedUnlessSettled: vi.fn(),
}));
vi.mock('@api/services/billing/account.service', () => ({ assertPayableStore: vi.fn() }));
vi.mock('@api/services/billing/charge-amount', () => ({ chargeFor: vi.fn() }));
vi.mock('@api/lib/money-idempotency', () => ({ withIdempotencyKey: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({ config: { adminUrl: 'x', apiUrl: 'y' } }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));

const sel = (where: any, e: Record<string, any>) =>
  e.storeId === where.storeId &&
  (where.type === undefined || e.type === where.type) &&
  (where.status === undefined || e.status === where.status) &&
  (!where.planCode?.startsWith || (e.planCode ?? '').startsWith(where.planCode.startsWith)) &&
  (!where.forPeriodEnd?.gt || (e.forPeriodEnd && e.forPeriodEnd > where.forPeriodEnd.gt)) &&
  (!where.relatedEventId?.in || where.relatedEventId.in.includes(e.relatedEventId));
const tx = {
  billingEvent: {
    findMany: async ({ where, take }: any) =>
      h.events
        .filter(e => sel(where, e))
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, take ?? 1000),
    create: async ({ data }: any) => {
      h.created.push(data);
      h.events.push({ ...data, createdAt: new Date(NOW.getTime() + h.created.length) });
      return data;
    },
  },
  storeFeature: { findMany: async () => h.overrides },
};
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_id: string, fn: (t: unknown) => unknown) => fn(tx),
}));

import { cancelAddon, listAddonHistory, listAddons } from '@api/services/billing/addons.service';

const SKU = 'feature:floating_widget';
const row = (over: Record<string, any>) => ({
  id: 'e1',
  storeId: 's1',
  type: 'upgrade',
  status: 'succeeded',
  planCode: `addon:${SKU}`,
  amountMinor: 9900,
  vatMinor: 1200,
  vat: { rateBps: 1400 },
  currency: 'EGP',
  failureReason: null,
  provider: 'kashier',
  providerRef: 'secret-provider-ref',
  forPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
  createdAt: new Date(NOW.getTime() - 20 * DAY),
  ...over,
});
const stateOf = async (sku = SKU) =>
  (await listAddons('s1')).addons.find(a => a.sku === sku)!.state;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.events = [];
  h.created = [];
  h.overrides = [];
  h.withoutAddons = {};
  h.allFeatures = {};
});

describe('listAddons states come from the ledger', () => {
  it('available with no rows', async () => expect(await stateOf()).toBe('available'));

  it('pending payment: state is pending_payment and the live gate answer stays OFF', async () => {
    h.events = [
      row({ status: 'pending', forPeriodEnd: null, createdAt: new Date(NOW.getTime() - 60_000) }),
    ];
    const a = (await listAddons('s1')).addons.find(x => x.sku === SKU)!;
    expect(a.state).toBe('pending_payment');
    expect(a.enabled).toBe(false);
  });

  it('failed payment: state failed, nothing running', async () => {
    h.events = [
      row({ status: 'failed', forPeriodEnd: null, createdAt: new Date(NOW.getTime() - 3_600_000) }),
    ];
    expect(await stateOf()).toBe('failed');
  });

  it('a succeeded unexpired term is renewing, and the cancel marker moves it to cancelled_at_period_end', async () => {
    h.events = [row({})];
    expect(await stateOf()).toBe('renewing');
    const out = await cancelAddon({ storeId: 's1', sku: SKU });
    expect(out.effectiveAt.getTime()).toBe(NOW.getTime() + 10 * DAY);
    expect(h.created[0].planCode).toBe(`addon-cancel:${SKU}`);
    expect(await stateOf()).toBe('cancelled_at_period_end');
  });

  it('cancelled: active until the period end, then off (expired) once the clock passes it', async () => {
    h.events = [row({})];
    await cancelAddon({ storeId: 's1', sku: SKU });
    vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY - 1000));
    expect(await stateOf()).toBe('cancelled_at_period_end');
    vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY + 1000));
    expect(await stateOf()).toBe('expired');
  });

  it('refunded term is no longer running', async () => {
    h.events = [row({ status: 'refunded' })];
    expect(await stateOf()).toBe('refunded');
  });

  it('plan inclusion vs a super-admin grant, and a grant creates no ledger row', async () => {
    h.withoutAddons = { floating_widget: true };
    expect(await stateOf()).toBe('included');
    h.overrides = [{ featureKey: 'floating_widget' }];
    expect(await stateOf()).toBe('granted');
    expect(h.created).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('an AI pack row never reads as included, and is `active` while running', async () => {
    h.withoutAddons = { floating_widget: true };
    h.events = [row({ planCode: 'addon:ai:topup_300' })];
    expect(await stateOf('ai:topup_300')).toBe('active');
  });

  it('every state payload carries what the card needs (description, ar + en)', async () => {
    const a = (await listAddons('s1')).addons.find(x => x.sku === SKU)!;
    expect(a.descEn.length).toBeGreaterThan(30);
    expect(a.descAr.length).toBeGreaterThan(30);
  });
});

describe('listAddonHistory is receipt data only', () => {
  it('lists every attempt newest first with the add-on name, never a provider field', async () => {
    h.events = [
      row({ id: 'old', createdAt: new Date(NOW.getTime() - 40 * DAY), status: 'refunded' }),
      row({ id: 'new', failureReason: 'provider_error: 502 from kashier', status: 'failed' }),
      row({ id: 'marker', planCode: `addon-cancel:${SKU}`, amountMinor: 0 }),
      row({ id: 'plan', planCode: 'growth' }),
    ];
    const items = await listAddonHistory('s1');
    expect(items.map(i => i.id)).toEqual(['new', 'old']);
    expect(items[0].nameAr).toBe('الزر العائم');
    expect(items[0].failureReason).toBe('payment_not_completed');
    expect(JSON.stringify(items)).not.toContain('secret-provider-ref');
    expect(Object.keys(items[0])).not.toContain('provider');
    expect(items[0].vatMinor).toBe(1200);
  });
});
