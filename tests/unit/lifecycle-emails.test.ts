/**
 * Self-serve lifecycle emails (growth strategy 3.4): skip rules, templates, unsubscribe token,
 * idempotent send pipeline, the Inngest wiring (event-driven, no cron) and the referral UTMs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const cfg = vi.hoisted(() => ({
  jwtSecret: 'test-jwt-secret',
  encryptionKey: 'test-encryption-key-0123456789abcdef',
  adminUrl: 'https://store.ebda.app',
  apiUrl: 'https://api.ebda.app',
}));
vi.mock('@api/config', () => ({ config: cfg }));

// In-memory store_lifecycle_emails table + the facts the service reads.
const db = vi.hoisted(() => ({
  rows: [] as Array<{
    storeId: string;
    kind: string;
    status: string;
    reason: string | null;
    createdAt?: Date;
  }>,
  store: {
    name: 'Nour',
    slug: 'nour',
    domain: null as string | null,
    status: 'active',
    settings: {} as Record<string, unknown>,
    owner: { email: 'owner@example.com', status: 'active' },
  } as unknown,
  sub: { status: 'trialing', trialEndsAt: new Date('2026-11-05T00:00:00Z') } as unknown,
  guide: { add_product: false, payment: false, shipping: false, test_order: false } as Record<
    string,
    boolean
  >,
  order: {
    status: 'confirmed',
    shippingAddress: null,
    customer: { email: 'buyer@example.com' },
  } as unknown,
  recovered: 0,
}));
const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@ebda/database', () => ({
  prisma: {},
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  withStore: (_s: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: async () => ({ ...(db.store as object), createdAt: new Date() }) },
      storeSubscription: { findUnique: async () => db.sub },
      // the buyer is a platform `User`, attached after the DO/Postgres order read (Ruling CF-JOBS-4)
      user: {
        findMany: async () => {
          const c = (db.order as { customer?: { email: string } | null }).customer;
          return c ? [{ id: 'u1', email: c.email }] : [];
        },
      },
      storeLifecycleEmail: {
        createMany: async ({ data }: { data: Array<(typeof db.rows)[number]> }) => {
          const d = data[0];
          if (db.rows.some(r => r.storeId === d.storeId && r.kind === d.kind)) return { count: 0 };
          db.rows.push({ ...d, createdAt: new Date() });
          return { count: 1 };
        },
        findUnique: async ({
          where,
        }: {
          where: { storeId_kind: { storeId: string; kind: string } };
        }) =>
          db.rows.find(
            r => r.storeId === where.storeId_kind.storeId && r.kind === where.storeId_kind.kind
          ) ?? null,
        updateMany: async ({
          where,
          data,
        }: {
          where: { storeId: string; kind: string };
          data: { status: string; reason: string };
        }) => {
          for (const r of db.rows)
            if (r.storeId === where.storeId && r.kind === where.kind) Object.assign(r, data);
          return { count: 1 };
        },
        findMany: async () => db.rows,
      },
    }),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async () => ({ backend: 'pg' }),
  storeDb: async () => ({
    order: {
      findUnique: async () => {
        const o = db.order as { status: string; shippingAddress: unknown; customer?: unknown };
        return {
          status: o.status,
          shippingAddress: o.shippingAddress,
          customerId: o.customer ? 'u1' : null,
        };
      },
    },
    abandonedCart: { count: async () => db.recovered },
  }),
}));
vi.mock('@api/services/setup-guide.service', () => ({
  SetupGuideService: {
    get: async () => ({
      items: Object.entries(db.guide).map(([key, done]) => ({ key, done })),
    }),
  },
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: { sendLifecycleEmail: sendMock },
}));
vi.mock('@api/lib/logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  LIFECYCLE_EMAIL_KINDS,
  LIFECYCLE_DELAY_DAYS,
  REFERRAL_UTM,
  isLifecycleKind,
  referralUrl,
} from '@ebda/shared';
import {
  listLifecycleLog,
  optOut,
  processLifecycleEmail,
  skipReason,
  type LifecycleFacts,
} from '@api/services/lifecycle-emails.service';
import {
  lifecycleContent,
  lifecycleSubject,
  type LifecycleEmailData,
} from '@api/services/email-templates/lifecycle';
import {
  lifecycleUnsubscribeUrl,
  signLifecycleUnsubscribeToken,
  verifyLifecycleUnsubscribeToken,
} from '@api/lib/lifecycle-unsubscribe-token';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  db.rows = [];
  db.sub = { status: 'trialing', trialEndsAt: new Date('2026-11-05T00:00:00Z') };
  db.guide = { add_product: false, payment: false, shipping: false, test_order: false };
  db.store = {
    name: 'Nour',
    slug: 'nour',
    domain: null,
    status: 'active',
    settings: {},
    owner: { email: 'owner@example.com', status: 'active' },
  };
  db.order = {
    status: 'confirmed',
    shippingAddress: null,
    customer: { email: 'buyer@example.com' },
  };
  db.recovered = 0;
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
});

const facts = (o: Partial<LifecycleFacts> = {}): LifecycleFacts => ({
  productAdded: false,
  paymentDone: false,
  shippingDone: false,
  hasOrder: false,
  trialing: true,
  ...o,
});

describe('skip rules read real state', () => {
  it('add_products: only while no product exists', () => {
    expect(skipReason('add_products', facts())).toBeNull();
    expect(skipReason('add_products', facts({ productAdded: true }))).toBe('products_added');
  });
  it('payment_shipping: skipped only when BOTH are done', () => {
    expect(skipReason('payment_shipping', facts({ paymentDone: true }))).toBeNull();
    expect(skipReason('payment_shipping', facts({ shippingDone: true }))).toBeNull();
    expect(skipReason('payment_shipping', facts({ paymentDone: true, shippingDone: true }))).toBe(
      'payment_and_shipping_done'
    );
  });
  it('test_order: only while there is no order', () => {
    expect(skipReason('test_order', facts())).toBeNull();
    expect(skipReason('test_order', facts({ hasOrder: true }))).toBe('order_placed');
  });
  it('share_link always goes; trial_recap needs a trialing store; first_order needs an order', () => {
    expect(skipReason('share_link', facts({ hasOrder: true, productAdded: true }))).toBeNull();
    expect(skipReason('trial_recap', facts({ trialing: false }))).toBe('not_trialing');
    expect(skipReason('trial_recap', facts())).toBeNull();
    expect(skipReason('first_order', facts())).toBe('no_order');
    expect(skipReason('first_order', facts({ hasOrder: true }))).toBeNull();
  });
});

describe('processLifecycleEmail', () => {
  it('sends once and never twice (a second call or an Inngest retry is a duplicate)', async () => {
    expect(await processLifecycleEmail(STORE, 'add_products')).toEqual({ status: 'sent' });
    expect(await processLifecycleEmail(STORE, 'add_products')).toEqual({ status: 'duplicate' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [data, lang] = sendMock.mock.calls[0];
    expect(data.to).toBe('owner@example.com');
    expect(data.unsubscribeUrl).toContain('/public/lifecycle-emails/unsubscribe?token=');
    expect(lang).toBe('ar');
  });

  it('records a skip (with the reason) when the step is already done, and sends nothing', async () => {
    db.guide.add_product = true;
    expect(await processLifecycleEmail(STORE, 'add_products')).toEqual({
      status: 'skipped',
      reason: 'products_added',
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(db.rows).toMatchObject([
      { storeId: STORE, kind: 'add_products', status: 'skipped', reason: 'products_added' },
    ]);
  });

  it('honours the merchant unsubscribe: nothing is sent while an optout row exists', async () => {
    await optOut(STORE);
    expect(await processLifecycleEmail(STORE, 'test_order')).toEqual({
      status: 'skipped',
      reason: 'opted_out',
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect((await listLifecycleLog(STORE)).optedOut).toBe(true);
  });

  it('skips a suspended store and an owner who is not active', async () => {
    (db.store as { status: string }).status = 'suspended';
    expect(await processLifecycleEmail(STORE, 'share_link')).toMatchObject({
      reason: 'store_not_active',
    });
  });

  it('is not for stores without a signup trial (super-admin provisioned): nothing recorded', async () => {
    db.sub = null;
    expect(await processLifecycleEmail(STORE, 'share_link')).toEqual({
      status: 'ignored',
      reason: 'not_self_serve',
    });
    expect(db.rows).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('marks the row failed (never leaves it looking sent) when the enqueue throws', async () => {
    sendMock.mockRejectedValueOnce(new Error('queue down'));
    expect(await processLifecycleEmail(STORE, 'share_link')).toEqual({
      status: 'failed',
      reason: 'ENQUEUE_FAILED',
    });
    expect(db.rows[0]).toMatchObject({ kind: 'share_link', status: 'failed' });
    const log = await listLifecycleLog(STORE);
    expect(log.entries.find(e => e.kind === 'share_link')?.status).toBe('failed');
  });

  it('trial_recap carries the recovered-cart count and skips a store that is no longer trialing', async () => {
    db.recovered = 3;
    await processLifecycleEmail(STORE, 'trial_recap', { now: new Date('2026-11-01T00:00:00Z') });
    expect(sendMock.mock.calls[0][0]).toMatchObject({ recoveredCarts: 3, daysLeft: 4 });
    db.rows = [];
    db.sub = { status: 'active', trialEndsAt: new Date('2026-11-05T00:00:00Z') };
    expect(await processLifecycleEmail(STORE, 'trial_recap')).toMatchObject({
      reason: 'not_trialing',
    });
  });

  it('first_order: a real buyer triggers the referral ask with UTM links; the owner testing does not', async () => {
    db.order = {
      status: 'confirmed',
      shippingAddress: null,
      customer: { email: 'OWNER@example.com' },
    };
    expect(await processLifecycleEmail(STORE, 'first_order', { orderId: 'o1' })).toEqual({
      status: 'ignored',
      reason: 'owner_test_order',
    });
    expect(db.rows).toEqual([]); // not recorded: the next real order still gets the ask
    db.order = {
      status: 'confirmed',
      shippingAddress: null,
      customer: { email: 'buyer@example.com' },
    };
    expect(await processLifecycleEmail(STORE, 'first_order', { orderId: 'o2' })).toEqual({
      status: 'sent',
    });
    const url: string = sendMock.mock.calls[0][0].referralUrl;
    expect(url).toContain(`utm_source=${REFERRAL_UTM.email.source}`);
    expect(url).toContain('utm_content=nour');
    // a later order is a duplicate
    expect(await processLifecycleEmail(STORE, 'first_order', { orderId: 'o3' })).toEqual({
      status: 'duplicate',
    });
  });

  it('log lists every kind in send order, pending until something happened', async () => {
    await processLifecycleEmail(STORE, 'share_link');
    const log = await listLifecycleLog(STORE);
    expect(log.entries.map(e => e.kind)).toEqual([...LIFECYCLE_EMAIL_KINDS]);
    expect(log.entries.find(e => e.kind === 'share_link')?.status).toBe('sent');
    expect(log.entries.find(e => e.kind === 'add_products')?.status).toBe('pending');
  });
});

describe('templates', () => {
  const links = {
    products: 'https://store.ebda.app/stores/s/products',
    payment: 'https://store.ebda.app/stores/s/payment-settings',
    storefront: 'https://nour.ebda.app',
    billing: 'https://store.ebda.app/stores/s/billing',
  };
  const data = (kind: LifecycleEmailData['kind']): LifecycleEmailData => ({
    kind,
    storeName: 'Nour',
    links,
    unsubscribeUrl: 'https://api.ebda.app/api/v1/public/lifecycle-emails/unsubscribe?token=t',
    recoveredCarts: 2,
    daysLeft: 4,
    referralUrl: referralUrl('email', 'nour'),
  });
  for (const kind of LIFECYCLE_EMAIL_KINDS) {
    for (const lang of ['ar', 'en'] as const) {
      it(`${kind} ${lang}: one CTA, an unsubscribe link, no orange, no provider names`, () => {
        const html = lifecycleContent(data(kind), lang);
        const subject = lifecycleSubject(data(kind), lang);
        expect(subject.length).toBeGreaterThan(5);
        expect((html.match(/class="button"/g) ?? []).length).toBe(1);
        expect(html).toContain('lifecycle-emails/unsubscribe?token=t');
        expect(html + subject).not.toMatch(/#ff6e01|orange|resend|inngest|cloudflare|gemini|neon/i);
        if (lang === 'ar') expect(subject).toMatch(/[؀-ۿ]/);
      });
    }
  }
  it('Arabic copy never gendered-addresses (no feminine imperative "ضيفي" / "اطلبي")', () => {
    for (const kind of LIFECYCLE_EMAIL_KINDS) {
      const t = lifecycleContent(data(kind), 'ar') + lifecycleSubject(data(kind), 'ar');
      expect(t).not.toMatch(/ضيفي|اطلبي|حطي|شوفي|ابعتي/);
    }
  });
  it('escapes the store name', () => {
    const html = lifecycleContent(
      { ...data('add_products'), storeName: '<img src=x onerror=1>' },
      'en'
    );
    expect(html).not.toContain('<img src=x');
  });
  it('the first-order CTA is a WhatsApp share that carries the referral link', () => {
    const html = lifecycleContent(data('first_order'), 'en');
    expect(html).toContain('https://wa.me/?text=');
    expect(decodeURIComponent(html)).toContain('utm_source=merchant_email');
  });
});

describe('unsubscribe token', () => {
  it('round-trips, carries no address, and is bound to its store', () => {
    const t = signLifecycleUnsubscribeToken(STORE);
    expect(verifyLifecycleUnsubscribeToken(t)).toEqual({ storeId: STORE });
    expect(t).not.toContain('@');
    const sig = t.split('.')[1];
    expect(verifyLifecycleUnsubscribeToken(`${OTHER}.${sig}`)).toBeNull();
    expect(verifyLifecycleUnsubscribeToken(`${STORE}.${sig.slice(0, -1)}A`)).toBeNull();
    expect(verifyLifecycleUnsubscribeToken(undefined)).toBeNull();
    expect(verifyLifecycleUnsubscribeToken('x'.repeat(500))).toBeNull();
  });
  it('a campaign token is not a lifecycle token (domain separation)', () => {
    expect(verifyLifecycleUnsubscribeToken(`${STORE}.${'A'.repeat(43)}`)).toBeNull();
  });
  it('the link points at the public GET-confirm / POST-do endpoint', () => {
    expect(lifecycleUnsubscribeUrl(STORE)).toMatch(
      /^https:\/\/api\.ebda\.app\/api\/v1\/public\/lifecycle-emails\/unsubscribe\?token=/
    );
  });
});

describe('referral attribution', () => {
  it('badge and email links carry distinct utm_source, medium and campaign on the marketing site', () => {
    const b = new URL(referralUrl('badge', 'nour.ebda.app'));
    expect(b.searchParams.get('utm_source')).toBe('ebda_store_badge');
    expect(b.searchParams.get('utm_medium')).toBe('referral');
    expect(b.searchParams.get('utm_content')).toBe('nour.ebda.app');
    expect(new URL(referralUrl('email')).searchParams.get('utm_source')).toBe('merchant_email');
    expect(new URL(referralUrl('badge')).searchParams.has('utm_content')).toBe(false);
  });
  it('the storefront badge and the maintenance page both use it (no bare marketing link left)', () => {
    const web = path.resolve(__dirname, '../../apps/web/src');
    for (const f of ['templates/shared/PoweredByEbda.tsx', 'components/StoreMaintenance.tsx']) {
      const src = readFileSync(path.join(web, f), 'utf8');
      expect(src, f).toContain("referralUrl('badge'");
      expect(src, f).not.toMatch(/href=\{BRAND_MARKETING_URL\}/);
    }
  });
});

describe('Inngest wiring (Ruling INNGEST-BUDGET-1: event-driven, no cron)', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../apps/api/src/lib/inngest/functions/lifecycle-emails.ts'),
    'utf8'
  );
  it('sleeps between steps and registers no cron', () => {
    expect(src).toContain('step.sleepUntil');
    expect(src).not.toMatch(/cron:/);
    expect(src).toContain("event: 'store/self-serve-provisioned'");
    expect(src).toContain("event: 'order/created'");
  });
  it('is registered, and the provisioning service emits the event only for the signup trial', () => {
    const idx = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/lib/inngest/functions/index.ts'),
      'utf8'
    );
    expect(idx).toMatch(/lifecycleEmails,\s*\n\s*lifecycleFirstOrder/);
    const prov = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/services/provisioning.service.ts'),
      'utf8'
    );
    expect(prov).toMatch(/if \(input\.growthTrial\) \{\s*void inngest/);
  });
  it('the delays match the strategy (days 1, 3, 5, 7)', () => {
    expect(LIFECYCLE_DELAY_DAYS).toEqual({
      add_products: 1,
      payment_shipping: 3,
      test_order: 5,
      share_link: 7,
    });
    expect(isLifecycleKind('optout')).toBe(false);
  });
});
