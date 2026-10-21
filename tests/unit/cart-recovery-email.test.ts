/**
 * Abandoned-cart recovery EMAIL (cart-email-campaigns, 2026-10-21).
 * Plan: docs/plans/2026-10-21-cart-email-campaigns.md.
 *
 * The service runs against a tiny in-memory Prisma that EVALUATES `where`
 * clauses (reusing the campaign fake's matcher), so removing a predicate from
 * the production query turns a test red: that is how the consent filter, the
 * once-per-cart claim and the converted-cart stop are mutation-checkable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matches, uuid, STORE_A, STORE_B } from '../helpers/campaign-fake-db';

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  process.env.API_URL = 'https://api.test';
  process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = 'unit-test-secret';
  return {
    db: {
      carts: [] as Row[],
      configs: [] as Row[],
      stores: [] as Row[],
      subs: [] as Row[],
    },
    send: vi.fn(async (_p?: unknown) => ({ ids: ['evt'] })),
    sendMarketingEmail: vi.fn(async (..._a: unknown[]) => ({ id: 'msg_1' })),
    isFeatureEnabled: vi.fn(async (..._a: unknown[]) => true),
    awaitSlot: vi.fn(async (..._a: unknown[]) => true),
  };
});
const { db } = h;

function table(rows: () => Row[]) {
  const pick = (r: Row, select?: Row) => {
    if (!select) return { ...r };
    const o: Row = {};
    for (const [k, v] of Object.entries(select)) if (v) o[k] = r[k];
    return o;
  };
  return {
    findMany: async ({ where, select }: { where?: Row; select?: Row } = {}) =>
      rows()
        .filter(r => matches(r, where))
        .map(r => pick(r, select)),
    findFirst: async ({ where, select }: { where?: Row; select?: Row } = {}) => {
      const r = rows().find(x => matches(x, where));
      return r ? pick(r, select) : null;
    },
    findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
      const r = rows().find(x => Object.entries(where).every(([k, v]) => x[k] === v));
      return r ? pick(r, select) : null;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows().filter(r => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
}

vi.mock('@ebda/database', () => {
  const prisma = {
    abandonedCart: table(() => h.db.carts),
    abandonedCartConfig: table(() => h.db.configs),
    store: table(() => h.db.stores),
    newsletterSubscriber: table(() => h.db.subs),
  };
  return {
    prisma,
    acrossStoresFlat: async (fn: (storeId: string) => Promise<unknown[]>) => {
      const ids = [...new Set(h.db.stores.map(s => s.id))];
      return (await Promise.all(ids.map(fn))).flat();
    },
    runInStoreScope: (_s: string, fn: () => unknown) => fn(),
    runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  };
});
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: h.send, createFunction: vi.fn() } }));
vi.mock('@api/services/resend.service', () => {
  class ResendSendError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  }
  return { ResendService: { sendMarketingEmail: h.sendMarketingEmail }, ResendSendError };
});
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.isFeatureEnabled },
}));
vi.mock('@api/lib/campaign-send-pacer', () => ({ awaitCampaignSendSlot: h.awaitSlot }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ResendSendError } from '@api/services/resend.service';
import {
  cartEmailDueAt,
  sweepCartRecoveryEmails,
  deliverCartRecoveryEmail,
  renderCartRecoveryEmail,
  CART_EMAIL_DEFAULT_DELAY_MINUTES,
  CART_EMAIL_MIN_DELAY_MINUTES,
  CART_EMAIL_MAX_DELAY_MINUTES,
} from '@api/services/cart-recovery-email.service';
import { verifySubscriberUnsubscribeToken } from '@api/lib/campaign-unsubscribe-token';

const MIN = 60_000;
const NOW = new Date('2026-10-21T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);

function store(id = STORE_A, extra: Row = {}) {
  return {
    id,
    name: 'Nile Goods',
    nameAr: 'نيل جودز',
    logo: null,
    email: 'owner@nile.test',
    phone: null,
    address: null,
    theme: null,
    settings: { defaultLanguage: 'ar' },
    slug: 'nile',
    domain: null,
    emailSenderLocalPart: null,
    emailDomainStatus: null,
    ...extra,
  };
}

function cart(extra: Row = {}) {
  return {
    id: uuid(),
    storeId: STORE_A,
    cartId: uuid(),
    customerEmail: 'Sara@Example.com',
    status: 'pending',
    cartTotal: 45000,
    cartItemCount: 2,
    cartItems: [
      { productName: 'Linen shirt', productImage: null, price: 25000, quantity: 1 },
      { productName: 'Leather belt', productImage: null, price: 20000, quantity: 1 },
    ],
    emailStatus: null,
    emailDetail: null,
    emailSentAt: null,
    createdAt: ago(130),
    ...extra,
  };
}

function config(extra: Row = {}) {
  return {
    id: uuid(),
    storeId: STORE_A,
    emailEnabled: true,
    emailDelayMinutes: 120,
    ...extra,
  };
}

function sub(email: string, extra: Row = {}) {
  return {
    id: uuid(),
    storeId: STORE_A,
    email,
    language: null,
    isActive: true,
    unsubscribedAt: null,
    ...extra,
  };
}

beforeEach(() => {
  db.carts.length = 0;
  db.configs.length = 0;
  db.stores.length = 0;
  db.subs.length = 0;
  db.stores.push(store());
  h.send.mockReset().mockResolvedValue({ ids: ['evt'] });
  h.sendMarketingEmail.mockReset().mockResolvedValue({ id: 'msg_1' });
  h.isFeatureEnabled.mockReset().mockResolvedValue(true);
  h.awaitSlot.mockReset().mockResolvedValue(true);
});

describe('delay', () => {
  it('default 2h, bounds 1h..24h (cart is only recorded after 1h idle)', () => {
    expect(CART_EMAIL_DEFAULT_DELAY_MINUTES).toBe(120);
    expect(CART_EMAIL_MIN_DELAY_MINUTES).toBe(60);
    expect(CART_EMAIL_MAX_DELAY_MINUTES).toBe(1440);
  });

  it('is measured from last activity: the 60 idle minutes are already behind the record', () => {
    const created = new Date('2026-10-21T10:00:00Z');
    expect(cartEmailDueAt(created, 120).toISOString()).toBe('2026-10-21T11:00:00.000Z');
    expect(cartEmailDueAt(created, 60).toISOString()).toBe(created.toISOString());
  });
});

describe('sweepCartRecoveryEmails', () => {
  it('claims a due cart once and sends one event keyed by the cart', async () => {
    db.configs.push(config());
    const c = cart();
    db.carts.push(c);
    const first = await sweepCartRecoveryEmails(NOW);
    expect(first.claimed).toBe(1);
    expect(c.emailStatus).toBe('queued');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({
      id: `cart-recovery-email/${c.id}`,
      name: 'cart-recovery/email-requested',
      data: { abandonedCartId: c.id, storeId: STORE_A },
    });
    // a second sweep (next cron tick) never claims it again
    const second = await sweepCartRecoveryEmails(NOW);
    expect(second.claimed).toBe(0);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('ignores a cart that is not due yet', async () => {
    db.configs.push(config({ emailDelayMinutes: 240 }));
    db.carts.push(cart({ createdAt: ago(130) })); // due after 180 minutes
    expect((await sweepCartRecoveryEmails(NOW)).claimed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does nothing when the merchant has the email channel off (or no config row)', async () => {
    db.configs.push(config({ emailEnabled: false }));
    db.carts.push(cart());
    expect((await sweepCartRecoveryEmails(NOW)).claimed).toBe(0);
    db.configs.length = 0;
    expect((await sweepCartRecoveryEmails(NOW)).claimed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('never claims a recovered cart or one without an email', async () => {
    db.configs.push(config());
    db.carts.push(cart({ status: 'recovered' }), cart({ customerEmail: null }));
    expect((await sweepCartRecoveryEmails(NOW)).claimed).toBe(0);
  });

  it("only touches the store's own carts: store B with the channel off stays untouched", async () => {
    db.stores.push(store(STORE_B));
    db.configs.push(config({ storeId: STORE_B, emailEnabled: false }));
    const other = cart({ storeId: STORE_B });
    db.carts.push(other);
    await sweepCartRecoveryEmails(NOW);
    expect(other.emailStatus).toBeNull();
  });

  it('a cart that waited too long (merchant enabled the channel late) is skipped as stale, not mailed', async () => {
    db.configs.push(config());
    const old = cart({ createdAt: ago(60 * 20) });
    db.carts.push(old);
    const r = await sweepCartRecoveryEmails(NOW);
    expect(r.claimed).toBe(0);
    expect(old.emailStatus).toBe('skipped');
    expect(old.emailDetail).toBe('stale');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('enqueue failure marks the row failed, never an orphan queued row', async () => {
    db.configs.push(config());
    const c = cart();
    db.carts.push(c);
    h.send.mockRejectedValueOnce(new Error('inngest down'));
    const r = await sweepCartRecoveryEmails(NOW);
    expect(r.claimed).toBe(0);
    expect(r.failed).toBe(1);
    expect(c.emailStatus).toBe('failed');
    expect(c.emailDetail).toBe('ENQUEUE_FAILED');
  });
});

describe('deliverCartRecoveryEmail', () => {
  function queued(extra: Row = {}) {
    db.configs.push(config());
    const c = cart({ emailStatus: 'queued', ...extra });
    db.carts.push(c);
    return c;
  }

  it('sends one store-branded email to an opted-in subscriber, with unsubscribe + headers', async () => {
    const c = queued();
    const s = sub('sara@example.com', { language: 'ar' });
    db.subs.push(s);
    const r = await deliverCartRecoveryEmail(STORE_A, c.id);
    expect(r.outcome).toBe('sent');
    expect(h.sendMarketingEmail).toHaveBeenCalledTimes(1);
    const [storeArg, opts] = h.sendMarketingEmail.mock.calls[0] as [Row, Row];
    // sender identity comes from the STORE (resolveSender), never a platform inbox
    expect(storeArg.id).toBe(STORE_A);
    expect(storeArg.name).toBe('Nile Goods');
    expect(opts.to).toBe('sara@example.com');
    expect(opts.idempotencyKey).toBe(`cart-recovery-email/${c.id}`);
    expect(opts.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const m = /token=([^>]+)>/.exec(opts.headers['List-Unsubscribe']);
    expect(verifySubscriberUnsubscribeToken(decodeURIComponent(m![1]))).toEqual({
      storeId: STORE_A,
      subscriberId: s.id,
    });
    expect(opts.html).toContain('/unsubscribe?token=');
    expect(opts.html).toContain('https://nile.ebda.app/cart');
    expect(c.emailStatus).toBe('sent');
    expect(c.emailSentAt).toBeInstanceOf(Date);
  });

  it('is idempotent: a second delivery of the same cart never sends again', async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com'));
    await deliverCartRecoveryEmail(STORE_A, c.id);
    const again = await deliverCartRecoveryEmail(STORE_A, c.id);
    expect(again.outcome).toBe('noop');
    expect(h.sendMarketingEmail).toHaveBeenCalledTimes(1);
  });

  it('does not mail an unclaimed cart (status must be queued)', async () => {
    const c = queued({ emailStatus: null });
    db.subs.push(sub('sara@example.com'));
    expect((await deliverCartRecoveryEmail(STORE_A, c.id)).outcome).toBe('noop');
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('no newsletter consent -> skipped, nothing sent', async () => {
    const c = queued();
    expect((await deliverCartRecoveryEmail(STORE_A, c.id)).outcome).toBe('skipped');
    expect(c.emailStatus).toBe('skipped');
    expect(c.emailDetail).toBe('no_consent');
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('an unsubscribed subscriber is never mailed', async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com', { isActive: false, unsubscribedAt: new Date() }));
    expect((await deliverCartRecoveryEmail(STORE_A, c.id)).outcome).toBe('skipped');
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('any casing variant of the address that unsubscribed blocks the send', async () => {
    const c = queued();
    db.subs.push(
      sub('sara@example.com'),
      sub('SARA@example.com', { isActive: false, unsubscribedAt: new Date() })
    );
    expect((await deliverCartRecoveryEmail(STORE_A, c.id)).outcome).toBe('skipped');
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it("another store's subscriber is not consent for this store", async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com', { storeId: STORE_B }));
    expect((await deliverCartRecoveryEmail(STORE_A, c.id)).detail).toBe('no_consent');
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('a cart that converted (recovered) before the send is skipped', async () => {
    const c = queued({ status: 'recovered' });
    db.subs.push(sub('sara@example.com'));
    const r = await deliverCartRecoveryEmail(STORE_A, c.id);
    expect(r.outcome).toBe('skipped');
    expect(c.emailDetail).toBe('recovered');
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('merchant switched the channel off while the job was queued -> skipped', async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com'));
    db.configs[0].emailEnabled = false;
    expect((await deliverCartRecoveryEmail(STORE_A, c.id)).detail).toBe('disabled');
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('plan without abandoned-cart recovery -> skipped (same gating as push/SMS)', async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com'));
    h.isFeatureEnabled.mockResolvedValue(false);
    expect((await deliverCartRecoveryEmail(STORE_A, c.id)).detail).toBe('feature_off');
    expect(h.isFeatureEnabled).toHaveBeenCalledWith(STORE_A, 'abandoned_cart');
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('a rate limit rethrows (the step retries) and leaves the row queued', async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com'));
    h.sendMarketingEmail.mockRejectedValueOnce(new ResendSendError('rate_limit_exceeded', 'slow'));
    await expect(deliverCartRecoveryEmail(STORE_A, c.id)).rejects.toThrow('slow');
    expect(c.emailStatus).toBe('queued');
    // the retry sends (and Resend dedupes by the idempotency key)
    expect((await deliverCartRecoveryEmail(STORE_A, c.id)).outcome).toBe('sent');
  });

  it('a permanent provider error marks the row failed with the code', async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com'));
    h.sendMarketingEmail.mockRejectedValueOnce(new ResendSendError('validation_error', 'bad to'));
    const r = await deliverCartRecoveryEmail(STORE_A, c.id);
    expect(r.outcome).toBe('failed');
    expect(c.emailStatus).toBe('failed');
  });

  it('waits for a platform send slot and retries (throws) when none is free', async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com'));
    h.awaitSlot.mockResolvedValueOnce(false);
    await expect(deliverCartRecoveryEmail(STORE_A, c.id)).rejects.toThrow(/send slot/i);
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
    expect(c.emailStatus).toBe('queued');
  });

  it("uses the subscriber's language, else the store default", async () => {
    const c = queued();
    db.subs.push(sub('sara@example.com', { language: 'en' }));
    await deliverCartRecoveryEmail(STORE_A, c.id);
    const opts = h.sendMarketingEmail.mock.calls[0][1] as Row;
    expect(opts.subject).toContain('Nile Goods');
    expect(opts.subject).toMatch(/cart/i);
  });
});

describe('renderCartRecoveryEmail', () => {
  const base = {
    store: store() as any,
    items: [
      { productName: 'Linen <b>shirt</b>', productImage: null, price: 25000, quantity: 2 },
      { productName: 'Leather belt', productImage: null, price: 20000, quantity: 1 },
    ],
    total: 70000,
    cartUrl: 'https://nile.ebda.app/cart',
    unsubscribeUrl: 'https://nile.ebda.app/unsubscribe?token=abc',
  };

  it('Arabic is Egyptian: إنت, joined negation, no حضرتك, no MSA markers', () => {
    const { subject, html } = renderCartRecoveryEmail({ ...base, locale: 'ar' });
    const text = `${subject} ${html.replace(/<[^>]+>/g, ' ')}`;
    expect(text).toContain('سلتك');
    for (const banned of ['حضرتك', 'علشان', 'هذا', 'هذه', 'يرجى', 'لم ', 'تم ', 'سوف', 'يمكنك']) {
      expect(text).not.toContain(banned);
    }
    expect(text).not.toMatch(/ما\s+\S+ش\b/);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('نيل جودز');
  });

  it('English renders the same facts', () => {
    const { subject, html } = renderCartRecoveryEmail({ ...base, locale: 'en' });
    expect(subject).toBe('You left something in your cart at Nile Goods');
    expect(html).toContain('https://nile.ebda.app/cart');
    expect(html).toContain('Leather belt');
  });

  it('escapes product names and carries a live unsubscribe link in both languages', () => {
    for (const locale of ['ar', 'en'] as const) {
      const { html } = renderCartRecoveryEmail({ ...base, locale });
      expect(html).not.toContain('<b>shirt</b>');
      expect(html).toContain('&lt;b&gt;shirt&lt;/b&gt;');
      expect(html).toContain('href="https://nile.ebda.app/unsubscribe?token=abc"');
    }
  });

  it('lists at most five items and says how many more', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      productName: `Item ${i + 1}`,
      productImage: null,
      price: 1000,
      quantity: 1,
    }));
    const { html } = renderCartRecoveryEmail({ ...base, items, locale: 'en' });
    expect(html).toContain('Item 5');
    expect(html).not.toContain('Item 6');
    expect(html).toContain('3 more');
  });

  it('survives a malformed cart snapshot', () => {
    const { html } = renderCartRecoveryEmail({
      ...base,
      items: [{ nope: true }, null, 'x'] as any,
      locale: 'en',
    });
    expect(html).toContain('https://nile.ebda.app/cart');
  });
});
