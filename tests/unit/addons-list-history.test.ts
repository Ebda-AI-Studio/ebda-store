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
  claims: [] as Array<Record<string, any>>,
  aiByFeature: [] as Array<{ feature: string; count: number }>,
  plan: 'starter' as string,
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: async () => false,
    getStoreFeatures: async () => h.allFeatures,
    resolveWithoutAddons: async () => h.withoutAddons,
  },
}));
vi.mock('@api/lib/ai-quota', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storeAiAllowance: async () => ({ baseCap: 150, extra: 0, cap: 150, used: 0, remaining: 150 }),
  storeAiUsageByFeature: async () => h.aiByFeature,
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
  store: { findUnique: async () => ({ plan: h.plan }) },
  storeFeature: { findMany: async () => h.overrides },
  manualPaymentClaim: {
    findMany: async ({ where }: any) =>
      h.claims
        .filter(c => where.status.in.includes(c.status))
        .sort((a, b) => +b.createdAt - +a.createdAt),
    count: async () => h.claims.filter(c => c.status === 'pending').length,
  },
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
  h.claims = [];
  h.aiByFeature = [];
  h.plan = 'starter';
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

describe('InstaPay add-on claims: waiting is never "on"', () => {
  const claim = (over: Record<string, any> = {}) => ({
    id: 'c1',
    planCode: `addon:${SKU}`,
    status: 'pending',
    amountMinor: 9900,
    reviewNote: null,
    createdAt: new Date(NOW.getTime() - 3_600_000),
    ...over,
  });

  it('a pending claim: waiting_confirmation, the live gate answer stays OFF, instapay offered', async () => {
    h.claims = [claim()];
    const out = await listAddons('s1');
    const a = out.addons.find(x => x.sku === SKU)!;
    expect(a.state).toBe('waiting_confirmation');
    expect(a.enabled).toBe(false);
    expect(a.active).toBeNull();
    expect(typeof out.instapayAvailable).toBe('boolean');
  });

  it('a rejected claim leaves nothing active and says rejected', async () => {
    h.claims = [claim({ status: 'rejected' })];
    const a = (await listAddons('s1')).addons.find(x => x.sku === SKU)!;
    expect(a.state).toBe('rejected');
    expect(a.enabled).toBe(false);
  });

  it('an expired (stale) pending claim leaves nothing active and Buy returns', async () => {
    h.claims = [claim({ createdAt: new Date(NOW.getTime() - 8 * DAY) })];
    expect(await stateOf()).toBe('available');
  });

  it('history shows the waiting and rejected claims as such, never as a payment', async () => {
    h.claims = [
      claim(),
      claim({ id: 'c2', status: 'rejected', createdAt: new Date(NOW.getTime() - DAY) }),
    ];
    const items = await listAddonHistory('s1');
    expect(items.map(i => [i.id, i.status])).toEqual([
      ['c1', 'waiting_confirmation'],
      ['c2', 'rejected'],
    ]);
  });
});

describe('AI credits meter data (existing quota ledger, no new table)', () => {
  it('returns what used today by feature, and the running packs with their end date', async () => {
    h.aiByFeature = [
      { feature: 'translate', count: 40 },
      { feature: 'seo', count: 7 },
    ];
    h.events = [
      row({
        id: 'p1',
        planCode: 'addon:ai:topup_300',
        forPeriodEnd: new Date(NOW.getTime() + 5 * DAY),
      }),
      row({
        id: 'p2',
        planCode: 'addon:ai:topup_300',
        forPeriodEnd: new Date(NOW.getTime() - DAY),
      }), // ended
    ];
    const { ai } = await listAddons('s1');
    expect(ai.byFeature).toEqual(h.aiByFeature);
    expect(ai.packs).toHaveLength(1);
    expect(ai.packs[0]).toMatchObject({ sku: 'ai:topup_300', extraRequests: 300 });
    expect(new Date(ai.packs[0].endsAt).getTime()).toBe(NOW.getTime() + 5 * DAY);
  });
});

describe('top-ups the EFFECTIVE platform cap cannot back are not listed', () => {
  const topups = async () =>
    (await listAddons('s1')).addons.filter(a => a.kind === 'ai_topup').map(a => a.sku);
  it('prod cap 1800/day: a store share is 900, so +300 is listed and +1000 is not', async () => {
    process.env.AI_DAILY_REQUEST_CAP = '1800';
    try {
      expect(await topups()).toEqual(['ai:topup_300']);
    } finally {
      delete process.env.AI_DAILY_REQUEST_CAP;
    }
  });
  it('cap 450: no top-up is listed', async () => {
    process.env.AI_DAILY_REQUEST_CAP = '450';
    try {
      expect(await topups()).toEqual([]);
    } finally {
      delete process.env.AI_DAILY_REQUEST_CAP;
    }
  });
  it('cap 5000: both are listed', async () => {
    process.env.AI_DAILY_REQUEST_CAP = '5000';
    try {
      expect(await topups()).toEqual(['ai:topup_300', 'ai:topup_1000']);
    } finally {
      delete process.env.AI_DAILY_REQUEST_CAP;
    }
  });
});
