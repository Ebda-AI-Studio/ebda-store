/**
 * Independent review of store#775 (money): renewal consent, admin override, renewal guards, refund cache, append-only cancel.
 * Each describe is one finding; every guard here was removed once to see its test go red (see the PR comment).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claimEvent: vi.fn(),
  chargeAndSettle: vi.fn(),
  effects: [] as any[],
  events: [] as Array<Record<string, any>>,
  offRow: null as any,
  plan: { floating_widget: false } as Record<string, boolean>,
  sentinels: new Set<string>(),
  redisUp: true,
  chargeFor: vi.fn(),
  sub: {
    id: 'sub1',
    provider: 'kashier',
    providerPaymentMethodRef: 'enc',
    status: 'active',
  } as any,
  created: [] as any[],
}));

vi.mock('@api/services/billing/subscription-billing.service', () => ({
  claimEvent: h.claimEvent,
  chargeAndSettle: h.chargeAndSettle,
  markFailedUnlessSettled: vi.fn(),
}));
vi.mock('@api/services/billing/account.service', () => ({
  assertPayableStore: async () => undefined,
  isBillableStoreId: async () => true,
}));
vi.mock('@api/services/billing/charge-amount', () => ({ chargeFor: h.chargeFor }));
vi.mock('@api/services/billing/index', () => ({
  getBillingProvider: () => ({ name: 'kashier' }),
  resolveTrialCardMode: () => 'card_on_file',
}));
vi.mock('@api/services/billing/billing-notify', () => ({
  runBillingEffects: async (e: any[]) => void h.effects.push(...e),
}));
vi.mock('@api/services/encryption.service', () => ({ encryption: { decrypt: () => 'tok' } }));
vi.mock('@api/services/platform/billing-d1', () => ({
  onD1: async () => false,
  claimAddonMarkerD1: vi.fn(),
  setTermEndOnceD1: vi.fn(),
  acrossBilling: async (fn: (s?: string) => Promise<unknown>) => [
    { storeId: 's1', value: await fn('s1') },
  ],
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: async () => false,
    resolveWithoutAddons: async () => h.plan,
  },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: () => h.redisUp,
    getClient: () =>
      h.redisUp
        ? {
            set: async (k: string, _v: string, _e: string, _t: number, _nx: string) => {
              if (h.sentinels.has(k)) return null;
              h.sentinels.add(k);
              return 'OK';
            },
            get: async (k: string) => (h.sentinels.has(k) ? '1' : null),
          }
        : null,
  },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ countAiUsage: vi.fn() }));
vi.mock('@api/lib/ai-quota', () => ({ storeAiAllowance: async () => ({}) }));
vi.mock('@api/lib/money-idempotency', () => ({
  idempotencyKeyOf: (v?: string) => v,
  withIdempotencyKey: async (_s: string, _k: string, fn: () => Promise<unknown>) => ({
    replayed: false,
    value: await fn(),
  }),
}));
vi.mock('@api/config', () => ({
  config: {
    adminUrl: 'https://admin.test',
    apiUrl: 'https://api.test',
    encryptionKey: 'a'.repeat(64),
  },
}));

const DAY = 86_400_000;
const NOW = new Date('2026-11-14T10:00:00.000Z');
const term = (over: Record<string, any> = {}) => ({
  id: 't1',
  storeId: 's1',
  type: 'upgrade',
  status: 'succeeded',
  planCode: 'addon:feature:floating_widget',
  amountMinor: 9900,
  forPeriodEnd: new Date(NOW.getTime() + 0.5 * DAY),
  createdAt: new Date(NOW.getTime() - 29.5 * DAY),
  relatedEventId: null,
  ...over,
});
const marker = (kind: 'cancel' | 'resume', over: Record<string, any> = {}) => ({
  id: `m-${kind}`,
  storeId: 's1',
  type: 'upgrade',
  status: 'succeeded',
  planCode: `addon-${kind}:feature:floating_widget`,
  amountMinor: 0,
  forPeriodEnd: null,
  createdAt: new Date(NOW.getTime() - DAY),
  relatedEventId: 't1',
  ...over,
});

function fakeTx() {
  const match = (e: any, w: any): boolean =>
    (w.storeId === undefined || e.storeId === w.storeId) &&
    (w.type === undefined || e.type === w.type) &&
    (w.status === undefined || e.status === w.status) &&
    (w.planCode === undefined ||
      (typeof w.planCode === 'string'
        ? e.planCode === w.planCode
        : w.planCode.startsWith
          ? e.planCode.startsWith(w.planCode.startsWith)
          : true)) &&
    (w.forPeriodEnd?.gt === undefined || (e.forPeriodEnd && e.forPeriodEnd > w.forPeriodEnd.gt)) &&
    (w.relatedEventId?.in === undefined || w.relatedEventId.in.includes(e.relatedEventId)) &&
    (typeof w.relatedEventId !== 'string' || e.relatedEventId === w.relatedEventId) &&
    (w.idempotencyKey === undefined || e.idempotencyKey === w.idempotencyKey) &&
    (w.id?.not === undefined || e.id !== w.id.not);
  return {
    billingEvent: {
      findMany: async ({ where }: any) => h.events.filter(e => match(e, where)),
      findFirst: async ({ where }: any) => h.events.filter(e => match(e, where))[0] ?? null,
      updateMany: vi.fn(async () => ({ count: 1 })),
      createMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async ({ data }: any) => {
        h.created.push(data);
        h.events.push({ createdAt: new Date(), ...data });
        return data;
      }),
    },
    store: {
      findUnique: async () => ({
        name: 'Shop',
        plan: 'starter',
        settings: {},
        owner: { email: 'm@x.test', firstName: 'M' },
      }),
    },
    manualPaymentClaim: { count: async () => 0 },
    storeSubscription: { findUnique: async () => h.sub },
    storeFeature: {
      findFirst: vi.fn(async () => h.offRow),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}
let tx = fakeTx();
vi.mock('@ebda/database', () => ({
  prisma: {
    billingEvent: {
      findMany: async ({ where }: any) =>
        h.events.filter(
          e =>
            e.type === where.type &&
            e.status === where.status &&
            e.planCode.startsWith(where.planCode.startsWith) &&
            e.forPeriodEnd &&
            e.forPeriodEnd >= where.forPeriodEnd.gte &&
            e.forPeriodEnd <= where.forPeriodEnd.lte
        ),
    },
  },
  withStore: async (_id: string, fn: (t: unknown) => unknown) => fn(tx),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.events = [];
  h.effects = [];
  h.created = [];
  h.offRow = null;
  h.plan = { floating_widget: false };
  h.sentinels = new Set();
  h.redisUp = true;
  h.sub = { id: 'sub1', provider: 'kashier', providerPaymentMethodRef: 'enc', status: 'active' };
  h.chargeFor.mockResolvedValue({ totalMinor: 9900, netMinor: 9900, vatMinor: 0, vat: null });
  h.claimEvent.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  h.chargeAndSettle.mockResolvedValue({ settled: 'succeeded' });
  tx = fakeTx();
});

describe('finding 1: the renewal is disclosed, bound into the token, and announced before each charge', () => {
  it('a feature preview states the renewal; an AI pack does not renew', async () => {
    const { previewAddon } = await import('@api/services/billing/addons.service');
    const f = await previewAddon({ storeId: 's1', userId: 'u1', sku: 'feature:floating_widget' });
    expect(f).toMatchObject({ renews: true, renewsEveryDays: 30, renewalMinor: 9900 });
    const p = await previewAddon({ storeId: 's1', userId: 'u1', sku: 'ai:topup_300' });
    expect(p).toMatchObject({ renews: false });
  });
  it('the renewal terms are inside the token hash (a token for a non-renewing quote cannot confirm a renewing one)', async () => {
    const { previewAddon } = await import('@api/services/billing/addons.service');
    const { hashConfirmArgs } = await import('@api/mcp/merchant-confirm-token');
    const f = await previewAddon({ storeId: 's1', userId: 'u1', sku: 'feature:floating_widget' });
    const payload = JSON.parse(Buffer.from(f.confirmToken.split('.')[0], 'base64url').toString());
    expect(payload.argsHash).toBe(
      hashConfirmArgs({
        sku: 'feature:floating_widget',
        totalMinor: 9900,
        renews: true,
        renewsEveryDays: 30,
        renewalMinor: 9900,
      })
    );
  });
  it('the confirm copy says it, in Arabic and English', async () => {
    const en = (await import('../../apps/admin/src/i18n/messages/en.json')).default as any;
    const ar = (await import('../../apps/admin/src/i18n/messages/ar.json')).default as any;
    for (const m of [en, ar]) {
      expect(m.addons.confirmRenews).toContain('{amount}');
      expect(m.addons.confirmRenews).toContain('{days}');
    }
  });
  it('the first renewal run only announces; it never charges without a prior notice', async () => {
    const { renewDueAddons } = await import('@api/services/billing/addon-renewal');
    h.events = [term()];
    expect(await renewDueAddons(NOW)).toBe(0);
    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.effects).toContainEqual(
      expect.objectContaining({
        kind: 'addon_notice',
        reason: 'renewal_upcoming',
        sku: 'feature:floating_widget',
      })
    );
  });
  it('after the notice, the next run charges the amount the merchant agreed to', async () => {
    const { renewDueAddons } = await import('@api/services/billing/addon-renewal');
    h.events = [term()];
    await renewDueAddons(NOW);
    h.effects = [];
    expect(await renewDueAddons(new Date(NOW.getTime() + 3600_000))).toBe(1);
    expect(h.claimEvent.mock.calls[0][0]).toMatchObject({
      amountMinor: 9900,
      planCode: 'addon:feature:floating_widget',
    });
  });
  it('no way to prove the notice went out (store unreachable) means no charge', async () => {
    const { renewDueAddons } = await import('@api/services/billing/addon-renewal');
    h.events = [term()];
    h.redisUp = false;
    expect(await renewDueAddons(NOW)).toBe(0);
    expect(h.claimEvent).not.toHaveBeenCalled();
  });
  it('a declined renewal tells the merchant', async () => {
    const { renewDueAddons } = await import('@api/services/billing/addon-renewal');
    h.events = [term()];
    await renewDueAddons(NOW);
    h.effects = [];
    h.chargeAndSettle.mockResolvedValue({ settled: 'failed' });
    await renewDueAddons(new Date(NOW.getTime() + 3600_000));
    expect(h.effects).toContainEqual(
      expect.objectContaining({ kind: 'addon_notice', reason: 'renewal_declined' })
    );
  });
});

describe('finding 3: a renewal that would surprise the merchant is not charged', () => {
  async function secondRun() {
    const { renewDueAddons } = await import('@api/services/billing/addon-renewal');
    await renewDueAddons(NOW); // the first run (its notice counts: a notice is sent once)
    h.claimEvent.mockClear();
    return renewDueAddons(new Date(NOW.getTime() + 3600_000));
  }
  it('a changed price: no charge, merchant told, new consent needed', async () => {
    h.events = [term()];
    h.chargeFor.mockResolvedValue({ totalMinor: 11286, netMinor: 9900, vatMinor: 1386, vat: {} });
    expect(await secondRun()).toBe(0);
    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.effects).toContainEqual(
      expect.objectContaining({ kind: 'addon_notice', reason: 'price_changed' })
    );
  });
  it('the plan now includes the feature: no charge, merchant told', async () => {
    h.events = [term()];
    h.plan = { floating_widget: true };
    expect(await secondRun()).toBe(0);
    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.effects).toContainEqual(expect.objectContaining({ reason: 'now_included' }));
  });
  it('a super-admin off: no charge, merchant told', async () => {
    h.events = [term()];
    h.offRow = { featureKey: 'floating_widget', enabled: false };
    expect(await secondRun()).toBe(0);
    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.effects).toContainEqual(expect.objectContaining({ reason: 'disabled' }));
  });
  it('a cancelled term is never renewed', async () => {
    h.events = [term(), marker('cancel')];
    expect(await secondRun()).toBe(0);
    expect(h.claimEvent).not.toHaveBeenCalled();
  });
  it('a resumed term renews again (latest marker wins)', async () => {
    h.events = [
      term(),
      marker('cancel', { createdAt: new Date(NOW.getTime() - 2 * DAY) }),
      marker('resume', { id: 'm2', createdAt: new Date(NOW.getTime() - DAY) }),
    ];
    expect(await secondRun()).toBe(1);
  });
});

describe('finding 2: a super-admin off is never deleted and blocks the sale', () => {
  it('the preview refuses while an admin "off" row exists', async () => {
    const { previewAddon } = await import('@api/services/billing/addons.service');
    h.offRow = { featureKey: 'floating_widget', enabled: false };
    await expect(
      previewAddon({ storeId: 's1', userId: 'u1', sku: 'feature:floating_widget' })
    ).rejects.toMatchObject({ code: 'FEATURE_DISABLED_BY_SUPPORT' });
  });
  it('the grant never deletes an override row', async () => {
    const { applyAddonGrant } = await import('@api/services/billing/addon-grant');
    await applyAddonGrant(
      tx as any,
      { id: 'e1', storeId: 's1', planCode: 'addon:feature:floating_widget' } as any,
      NOW,
      []
    );
    expect(tx.storeFeature.deleteMany).not.toHaveBeenCalled();
  });
  it('an "off" that appears between quote and payment grants nothing and hands the money back', async () => {
    const { applyAddonGrant } = await import('@api/services/billing/addon-grant');
    h.offRow = { featureKey: 'floating_widget', enabled: false };
    const effects: any[] = [];
    await applyAddonGrant(
      tx as any,
      { id: 'e1', storeId: 's1', planCode: 'addon:feature:floating_widget' } as any,
      NOW,
      effects
    );
    expect(tx.billingEvent.updateMany).not.toHaveBeenCalled();
    expect(effects).toEqual([{ kind: 'addon_unapplied', storeId: 's1', billingEventId: 'e1' }]);
  });
});

describe('finding 5: cancel and resume APPEND a ledger row, they never edit a paid row', () => {
  it('cancel appends a zero-amount marker tied to the running term', async () => {
    const { cancelAddon } = await import('@api/services/billing/addons.service');
    h.events = [term({ forPeriodEnd: new Date(NOW.getTime() + 10 * DAY) })];
    const out = await cancelAddon({ storeId: 's1', sku: 'feature:floating_widget' });
    expect(tx.billingEvent.updateMany).not.toHaveBeenCalled();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      planCode: 'addon-cancel:feature:floating_widget',
      amountMinor: 0,
      status: 'succeeded',
      relatedEventId: 't1',
      storeId: 's1',
    });
    expect(out.effectiveAt).toEqual(h.events[0].forPeriodEnd);
  });
  it('the running list reads the latest marker', async () => {
    const { activeAddons } = await import('@api/services/billing/addon-grant');
    h.events = [term({ forPeriodEnd: new Date(NOW.getTime() + 10 * DAY) }), marker('cancel')];
    expect((await activeAddons(tx as any, 's1', NOW))[0].cancelAtPeriodEnd).toBe(true);
    h.events.push(marker('resume', { id: 'm2', createdAt: new Date(NOW.getTime() - 1000) }));
    expect((await activeAddons(tx as any, 's1', NOW))[0].cancelAtPeriodEnd).toBe(false);
  });
  it('a marker is never itself an entitlement', async () => {
    const { activeAddons } = await import('@api/services/billing/addon-grant');
    h.events = [marker('cancel', { forPeriodEnd: new Date(NOW.getTime() + 10 * DAY) })];
    expect(await activeAddons(tx as any, 's1', NOW)).toEqual([]);
  });
});

describe('ADDON-SS-3: a term that ended is an entitlement change (cache layers cleared by the daily run)', () => {
  it('emits ONE addon_granted (cache bust) effect per lapsed store, and none for a running term', async () => {
    const { renewDueAddons } = await import('@api/services/billing/addon-renewal');
    h.events = [
      term({ id: 'gone1', forPeriodEnd: new Date(NOW.getTime() - 0.5 * DAY) }),
      term({
        id: 'gone2',
        planCode: 'addon:feature:loyalty',
        forPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      }),
    ];
    await renewDueAddons(NOW);
    expect(h.effects.filter(e => e.kind === 'addon_granted')).toEqual([
      { kind: 'addon_granted', storeId: 's1' },
    ]);
    h.effects = [];
    h.events = [term({ forPeriodEnd: new Date(NOW.getTime() + 0.5 * DAY) })];
    await renewDueAddons(NOW);
    expect(h.effects.filter(e => e.kind === 'addon_granted')).toEqual([]);
  });
});

describe('ADDON-SS-6: an InstaPay term is non-renewing (nothing can be charged, nothing is settled)', () => {
  it('an approved InstaPay term reaching its due date is NOT renewed, no event is written, and the owner is told to pay again', async () => {
    const { renewDueAddons } = await import('@api/services/billing/addon-renewal');
    h.events = [term({ provider: 'instapay' })];
    // run twice: the first run would only announce, the second would charge for a card term
    expect(await renewDueAddons(NOW)).toBe(0);
    expect(await renewDueAddons(new Date(NOW.getTime() + 3600_000))).toBe(0);
    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.chargeAndSettle).not.toHaveBeenCalled();
    expect(h.effects).toContainEqual(
      expect.objectContaining({ kind: 'addon_notice', reason: 'renew_via_instapay' })
    );
    expect(h.effects.filter(e => e.reason === 'renewal_upcoming')).toEqual([]);
  });
  it('the same term paid by card still renews (the rule is about the provider, not the add-on)', async () => {
    const { renewDueAddons } = await import('@api/services/billing/addon-renewal');
    h.events = [term({ provider: 'kashier' })];
    await renewDueAddons(NOW);
    expect(await renewDueAddons(new Date(NOW.getTime() + 3600_000))).toBe(1);
  });
});
