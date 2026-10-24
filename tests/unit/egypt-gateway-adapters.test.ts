/**
 * Paymob, Kashier and Fawry adapters: the parts the shared contract suite cannot say because
 * they are specific to one gateway's wire format.
 *
 *   - amount conversion at the edge: 1 piastre, the float traps (0.29, 0.57, 1.15), large
 *     amounts, and partial refunds that sum EXACTLY to what was captured;
 *   - signature TAMPER tests: every field a signature is supposed to cover, changed after
 *     signing, fails verification; a Kashier payload that names too few signed keys is refused;
 *   - Paymob void vs refund; Fawry reference code vs card; method selection;
 *   - the adapters never put a secret in an error message.
 */
import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  PaymentProviderError,
  type ProviderCredentials,
} from '@api/services/payment-providers/types';
import {
  createPaymobProvider,
  paymobHmac,
  PAYMOB_HMAC_FIELDS,
  PAYMOB_HMAC_HEADER,
} from '@api/services/payment-providers/paymob.provider';
import {
  createKashierProvider,
  kashierSignature,
  KASHIER_SIGNATURE_HEADER,
} from '@api/services/payment-providers/kashier.provider';
import {
  createFawryProvider,
  fawryNotificationSignature,
} from '@api/services/payment-providers/fawry.provider';
import { PaymobStub, PAYMOB_STUB } from '../stubs/paymob-stub';
import { KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';
import { FawryStub, FAWRY_STUB } from '../stubs/fawry-stub';
import { baseRequest } from '../contract/payment-provider.contract';

const paymobCreds: ProviderCredentials = {
  mode: 'sandbox',
  apiKey: PAYMOB_STUB.secretKey,
  secretKey: PAYMOB_STUB.apiKey,
  webhookSecret: PAYMOB_STUB.hmacSecret,
  settings: { publicKey: PAYMOB_STUB.publicKey, integrationIds: PAYMOB_STUB.integrationIds },
};
const kashierCreds: ProviderCredentials = {
  mode: 'sandbox',
  merchantId: KASHIER_STUB.merchantId,
  apiKey: KASHIER_STUB.apiKey,
  secretKey: KASHIER_STUB.secretKey,
  settings: { methods: ['card', 'wallet'], display: 'en' },
};
const fawryCreds: ProviderCredentials = {
  mode: 'sandbox',
  merchantId: FAWRY_STUB.merchantCode,
  apiKey: FAWRY_STUB.secureKey,
  settings: { methods: ['payatfawry', 'card'], expiryHours: 72 },
};

function paymob() {
  const stub = new PaymobStub();
  const provider = createPaymobProvider({
    fetchImpl: stub.fetch,
    timeoutMs: 100,
    baseUrls: { sandbox: PAYMOB_STUB.baseUrl },
  });
  return { stub, provider };
}
function kashier() {
  const stub = new KashierStub();
  const provider = createKashierProvider({
    fetchImpl: stub.fetch,
    timeoutMs: 100,
    baseUrls: { sandbox: KASHIER_STUB.baseUrl },
  });
  return { stub, provider };
}
function fawry() {
  const stub = new FawryStub();
  const provider = createFawryProvider({
    fetchImpl: stub.fetch,
    timeoutMs: 100,
    baseUrls: { sandbox: FAWRY_STUB.baseUrl },
  });
  return { stub, provider };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as PaymentProviderError).code;
  }
  return 'resolved';
};
const sync = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as PaymentProviderError).code;
  }
  return 'returned';
};

// ---------------------------------------------------------------------------------------------
// AMOUNTS
// ---------------------------------------------------------------------------------------------
describe('amount conversion at the gateway edge', () => {
  // 29, 57, 115, 1015 are the piastre counts where `x / 100` * 100 or `toFixed` drift.
  const traps = [1, 29, 57, 99, 115, 1_015, 1_999, 4_999_99, 1_000_000_01, 99_999_999_99];

  it.each(traps)('Paymob sends %i piastres as the SAME integer (cents == piastres)', async n => {
    const { stub, provider } = paymob();
    const res = await provider.createPayment(baseRequest({ amountMinor: n }), paymobCreds);
    const sent = stub.requests.find(r => r.path === '/v1/intention/')!.body;
    expect(sent.amount).toBe(n);
    expect(
      (sent.items as Array<{ amount: number; quantity: number }>).reduce(
        (a, i) => a + i.amount * i.quantity,
        0
      )
    ).toBe(n);
    expect(res.amountMinor).toBe(n);
  });

  it.each(traps)('Kashier sends %i piastres as an exact 2-dp decimal STRING', async n => {
    const { stub, provider } = kashier();
    const res = await provider.createPayment(baseRequest({ amountMinor: n }), kashierCreds);
    const sent = stub.requests.find(r => r.path === '/v3/payment/sessions')!.body.amount as string;
    expect(typeof sent).toBe('string');
    expect(sent).toMatch(/^\d+\.\d{2}$/);
    // The string, read back with integer math, is the original piastre count.
    const [whole, frac] = sent.split('.');
    expect(Number(whole) * 100 + Number(frac)).toBe(n);
    expect(res.amountMinor).toBe(n);
  });

  it.each(traps)(
    'Fawry sends %i piastres as a 2-dp number that signs and reads back exactly',
    async n => {
      const { stub, provider } = fawry();
      const res = await provider.createPayment(baseRequest({ amountMinor: n }), fawryCreds);
      const sent = stub.requests.find(r => r.path === '/ECommerceWeb/Fawry/payments/charge')!.body;
      // JSON number: its shortest decimal text is the 2-dp amount (a drifting float would not be).
      expect(String(sent.amount)).toBe((n / 100).toFixed(2).replace(/\.?0+$/, '') || '0');
      expect(Math.round((sent.amount as number) * 100)).toBe(n);
      expect(res.amountMinor).toBe(n);
    }
  );

  it('Fawry refuses an amount above its double-safe ceiling instead of sending an inexact one', async () => {
    const { provider } = fawry();
    expect(
      await code(
        provider.createPayment(baseRequest({ amountMinor: 1_000_000_000_001 }), fawryCreds)
      )
    ).toBe('AMOUNT_INVALID');
  });

  it.each([
    ['paymob', () => paymob()],
    ['kashier', () => kashier()],
    ['fawry', () => fawry()],
  ] as const)(
    '%s: partial refunds sum EXACTLY to the captured amount (no piastre lost to rounding)',
    async (name, make) => {
      const { stub, provider } = make();
      const creds =
        name === 'paymob' ? paymobCreds : name === 'kashier' ? kashierCreds : fawryCreds;
      const created = await provider.createPayment(baseRequest({ amountMinor: 10_001 }), creds);
      if (name === 'paymob') (stub as PaymobStub).capture(Number(created.providerRef));
      else (stub as KashierStub | FawryStub).capture(created.providerRef);
      let total = 0;
      for (const [i, part] of [3_333, 3_333, 3_335].entries()) {
        const r = await provider.partialRefund(
          { providerRef: created.providerRef, idempotencyKey: `p${i}`, amountMinor: part },
          creds
        );
        total += part;
        expect(r.amountMinor).toBe(part);
        expect(r.refundedTotalMinor).toBe(total);
      }
      expect(total).toBe(10_001);
      expect((await provider.getStatus(created.providerRef, creds)).refundedMinor).toBe(10_001);
      // and one more piastre is refused, changing nothing
      expect(
        await code(
          provider.partialRefund(
            { providerRef: created.providerRef, idempotencyKey: 'x', amountMinor: 1 },
            creds
          )
        )
      ).toBe('REFUND_EXCEEDS_CAPTURED');
    }
  );

  it('refund amounts reach each gateway in its own unit', async () => {
    const pm = paymob();
    const a = await pm.provider.createPayment(baseRequest({ amountMinor: 5_029 }), paymobCreds);
    pm.stub.capture(Number(a.providerRef));
    await pm.provider.partialRefund(
      { providerRef: a.providerRef, idempotencyKey: 'a', amountMinor: 1_029 },
      paymobCreds
    );
    expect(pm.stub.requests.find(r => r.path.endsWith('/refund'))!.body.amount_cents).toBe(1_029);

    const ks = kashier();
    const b = await ks.provider.createPayment(baseRequest({ amountMinor: 5_029 }), kashierCreds);
    ks.stub.capture(b.providerRef);
    await ks.provider.partialRefund(
      { providerRef: b.providerRef, idempotencyKey: 'b', amountMinor: 1_029 },
      kashierCreds
    );
    // Kashier's refund `transaction.amount` is a JSON NUMBER (documented), built from the exact decimal.
    expect(
      (ks.stub.requests.find(r => r.method === 'PUT')!.body.transaction as { amount: number })
        .amount
    ).toBe(10.29);

    const fw = fawry();
    const c = await fw.provider.createPayment(baseRequest({ amountMinor: 5_029 }), fawryCreds);
    fw.stub.capture(c.providerRef);
    await fw.provider.partialRefund(
      { providerRef: c.providerRef, idempotencyKey: 'c', amountMinor: 1_029 },
      fawryCreds
    );
    expect(fw.stub.requests.find(r => r.path.endsWith('/refund'))!.body.refundAmount).toBe(10.29);
  });

  it('a gateway amount with more than two decimals is a malformed webhook, never rounded', () => {
    const { stub, provider } = kashier();
    const created = stub.webhookFor('ORD-1-aaaaaaaaaa', {
      status: 'SUCCESS',
      amount: '10.001',
      transactionId: 't1',
    });
    expect(sync(() => provider.verifyWebhook(created.rawBody, created.headers, kashierCreds))).toBe(
      'WEBHOOK_MALFORMED'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// PAYMOB
// ---------------------------------------------------------------------------------------------
// Paymob callback fixtures below are dated 2026-10-04: pin the clock inside the freshness window.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
});
afterAll(() => vi.useRealTimers());

describe('Paymob', () => {
  const sample = () => {
    const { stub } = paymob();
    const order = 7001;
    return stub.callbackFor({
      id: 9001,
      orderId: order,
      amount_cents: 12_345,
      success: true,
      pending: false,
      is_voided: false,
      is_refunded: false,
      integration_id: 11,
      created_at: '2026-10-04T10:00:00.000000',
    });
  };

  it('the HMAC is SHA-512 over the 20 documented fields concatenated in the documented order', () => {
    const { body, hmac } = sample();
    const o = (body as { obj: Record<string, any> }).obj;
    // Written out by hand, NOT through paymobHmac: this is the documented formula.
    const manual =
      String(o.amount_cents) +
      o.created_at +
      o.currency +
      String(o.error_occured) +
      String(o.has_parent_transaction) +
      String(o.id) +
      String(o.integration_id) +
      String(o.is_3d_secure) +
      String(o.is_auth) +
      String(o.is_capture) +
      String(o.is_refunded) +
      String(o.is_standalone_payment) +
      String(o.is_voided) +
      String(o.order.id) +
      String(o.owner) +
      String(o.pending) +
      o.source_data.pan +
      o.source_data.sub_type +
      o.source_data.type +
      String(o.success);
    expect(PAYMOB_HMAC_FIELDS).toHaveLength(20);
    expect(crypto.createHmac('sha512', PAYMOB_STUB.hmacSecret).update(manual).digest('hex')).toBe(
      hmac
    );
    expect(paymobHmac(o, PAYMOB_STUB.hmacSecret)).toBe(hmac);
  });

  it.each([
    ['amount_cents', (o: any) => (o.amount_cents = 1)],
    ['success', (o: any) => (o.success = false)],
    ['pending', (o: any) => (o.pending = true)],
    ['is_voided', (o: any) => (o.is_voided = true)],
    ['is_refunded', (o: any) => (o.is_refunded = true)],
    ['id', (o: any) => (o.id = 1)],
    ['order.id', (o: any) => (o.order.id = 1)],
    ['integration_id', (o: any) => (o.integration_id = 22)],
    ['currency', (o: any) => (o.currency = 'USD')],
    ['created_at', (o: any) => (o.created_at = '2020-01-01T00:00:00.000000')],
    ['source_data.type', (o: any) => (o.source_data.type = 'wallet')],
    ['has_parent_transaction', (o: any) => (o.has_parent_transaction = true)],
    ['error_occured', (o: any) => (o.error_occured = true)],
  ])('a changed %s fails verification (the signature covers it)', (_field, mutate) => {
    const { provider } = paymob();
    const { body, hmac } = sample();
    const copy = JSON.parse(JSON.stringify(body));
    mutate(copy.obj);
    expect(
      sync(() =>
        provider.verifyWebhook(JSON.stringify(copy), { [PAYMOB_HMAC_HEADER]: hmac }, paymobCreds)
      )
    ).toBe('WEBHOOK_BAD_SIGNATURE');
  });

  it('a field the HMAC does NOT cover can change without breaking it (and is never trusted)', () => {
    const { provider } = paymob();
    const { body, hmac } = sample();
    const copy = JSON.parse(JSON.stringify(body));
    copy.obj.data = { message: 'anything' }; // not one of the 20
    const ev = provider.verifyWebhook(
      JSON.stringify(copy),
      { [PAYMOB_HMAC_HEADER]: hmac },
      paymobCreds
    );
    expect(ev.kind).toBe('payment');
  });

  it('the hex signature is compared case-insensitively and in constant time; a prefix is not enough', () => {
    const { provider } = paymob();
    const { body, hmac } = sample();
    const raw = JSON.stringify(body);
    expect(
      provider.verifyWebhook(raw, { [PAYMOB_HMAC_HEADER]: hmac.toUpperCase() }, paymobCreds).kind
    ).toBe('payment');
    expect(
      sync(() =>
        provider.verifyWebhook(raw, { [PAYMOB_HMAC_HEADER]: hmac.slice(0, 64) }, paymobCreds)
      )
    ).toBe('WEBHOOK_BAD_SIGNATURE');
    expect(sync(() => provider.verifyWebhook(raw, { [PAYMOB_HMAC_HEADER]: '' }, paymobCreds))).toBe(
      'WEBHOOK_BAD_SIGNATURE'
    );
  });

  it('a callback that is not a TRANSACTION, or is not signed, is never turned into an event', () => {
    const { provider } = paymob();
    const raw = JSON.stringify({ type: 'TOKEN', obj: { token: 'x' } });
    const sig = paymobHmac({ token: 'x' }, PAYMOB_STUB.hmacSecret);
    expect(
      sync(() => provider.verifyWebhook(raw, { [PAYMOB_HMAC_HEADER]: sig }, paymobCreds))
    ).toBe('WEBHOOK_MALFORMED');
    expect(
      sync(() => provider.verifyWebhook(raw, { [PAYMOB_HMAC_HEADER]: 'bad' }, paymobCreds))
    ).toBe('WEBHOOK_BAD_SIGNATURE');
    expect(sync(() => provider.verifyWebhook('not json', {}, paymobCreds))).toBe(
      'WEBHOOK_BAD_SIGNATURE'
    );
  });

  it('a refund / void transaction is a REFUND event about the order, with its own id', () => {
    const { stub, provider } = paymob();
    const { body, hmac } = stub.callbackFor({
      id: 9100,
      orderId: 7001,
      amount_cents: 3_000,
      success: true,
      pending: false,
      is_voided: false,
      is_refunded: true,
      integration_id: 11,
      created_at: '2026-10-04T10:00:00.000000',
      parent: 9001,
    });
    const ev = provider.verifyWebhook(
      JSON.stringify(body),
      { [PAYMOB_HMAC_HEADER]: hmac },
      paymobCreds
    );
    expect(ev).toMatchObject({
      kind: 'refund',
      providerRef: '7001',
      refundRef: '9100',
      amountMinor: 3_000,
      status: 'completed',
    });
  });

  it('method selection: only the named integration is offered; a method the merchant did not enable is refused', async () => {
    const { stub, provider } = paymob();
    await provider.createPayment(baseRequest({ metadata: { method: 'wallet' } }), paymobCreds);
    expect(stub.requests.find(r => r.path === '/v1/intention/')!.body.payment_methods).toEqual([
      22,
    ]);

    const none = {
      ...paymobCreds,
      settings: { publicKey: 'pk_xxxxxxxx', integrationIds: { card: 11 } },
    };
    expect(
      await code(provider.createPayment(baseRequest({ metadata: { method: 'valu' } }), none))
    ).toBe('PROVIDER_MISCONFIGURED');
    // no method named: every enabled integration, once
    const all = paymob();
    await all.provider.createPayment(baseRequest(), paymobCreds);
    expect(all.stub.requests[0].body.payment_methods).toEqual([11, 22, 33, 44, 55]);
  });

  it('items are sent only when they add up to the amount; otherwise one line carries it', async () => {
    const { stub, provider } = paymob();
    await provider.createPayment(
      baseRequest({
        amountMinor: 6_000,
        items: [
          { name: 'A', quantity: 1, unitPrice: 3_000 },
          { name: 'B', quantity: 1, unitPrice: 3_000 },
        ],
      }),
      paymobCreds
    );
    expect((stub.requests[0].body.items as unknown[]).length).toBe(2);
    await provider.createPayment(
      baseRequest({ amountMinor: 9_500, items: [{ name: 'A', quantity: 3, unitPrice: 3_000 }] }),
      paymobCreds
    );
    const second = stub.requests[1].body.items as Array<{ amount: number }>;
    expect(second).toHaveLength(1);
    expect(second[0].amount).toBe(9_500);
  });

  it('a same-day full refund is a VOID; a partial one, or one after a refund, is a REFUND', async () => {
    const full = paymob();
    const a = await full.provider.createPayment(baseRequest({ amountMinor: 8_000 }), paymobCreds);
    full.stub.capture(Number(a.providerRef));
    const r = await full.provider.refund(
      { providerRef: a.providerRef, idempotencyKey: 'v' },
      paymobCreds
    );
    expect(r).toMatchObject({ amountMinor: 8_000, refundedTotalMinor: 8_000 });
    expect(full.stub.requests.some(x => x.path.endsWith('/void'))).toBe(true);
    expect(full.stub.requests.some(x => x.path.endsWith('/refund'))).toBe(false);
    expect((await full.provider.getStatus(a.providerRef, paymobCreds)).status).toBe('refunded');

    const part = paymob();
    const b = await part.provider.createPayment(baseRequest({ amountMinor: 8_000 }), paymobCreds);
    part.stub.capture(Number(b.providerRef));
    await part.provider.partialRefund(
      { providerRef: b.providerRef, idempotencyKey: 'p', amountMinor: 2_000 },
      paymobCreds
    );
    await part.provider.refund({ providerRef: b.providerRef, idempotencyKey: 'rest' }, paymobCreds);
    expect(part.stub.requests.some(x => x.path.endsWith('/void'))).toBe(false);
    expect(part.stub.requests.filter(x => x.path.endsWith('/refund'))).toHaveLength(2);
  });

  it('when the gateway refuses the void (already settled) the refund goes through instead', async () => {
    const { stub, provider } = paymob();
    const a = await provider.createPayment(baseRequest({ amountMinor: 8_000 }), paymobCreds);
    stub.capture(Number(a.providerRef));
    stub.voidWindowOpen = false;
    const r = await provider.refund(
      { providerRef: a.providerRef, idempotencyKey: 'v2' },
      paymobCreds
    );
    expect(r.refundedTotalMinor).toBe(8_000);
    expect(stub.requests.some(x => x.path.endsWith('/refund'))).toBe(true);
  });

  it('voidPayment refuses an unpaid payment and one that already has a refund', async () => {
    const { stub, provider } = paymob();
    const a = await provider.createPayment(baseRequest({ amountMinor: 8_000 }), paymobCreds);
    expect(
      await code(
        provider.voidPayment({ providerRef: a.providerRef, idempotencyKey: 'u' }, paymobCreds)
      )
    ).toBe('PAYMENT_NOT_CAPTURED');
    stub.capture(Number(a.providerRef));
    await provider.partialRefund(
      { providerRef: a.providerRef, idempotencyKey: 'pr', amountMinor: 100 },
      paymobCreds
    );
    expect(
      await code(
        provider.voidPayment({ providerRef: a.providerRef, idempotencyKey: 'v3' }, paymobCreds)
      )
    ).toBe('REFUND_NOT_SUPPORTED');
  });

  it('a bad secret key is a configuration error (not an outage), and the key is never in the message', async () => {
    const { provider } = paymob();
    let err: PaymentProviderError | undefined;
    try {
      await provider.createPayment(baseRequest(), {
        ...paymobCreds,
        apiKey: 'sk_WRONG_super_secret',
      });
    } catch (e) {
      err = e as PaymentProviderError;
    }
    expect(err?.code).toBe('PROVIDER_MISCONFIGURED');
    expect(err?.isOutage).toBe(false);
    expect(err?.message).not.toContain('sk_WRONG_super_secret');
  });
});

// ---------------------------------------------------------------------------------------------
// KASHIER
// ---------------------------------------------------------------------------------------------
describe('Kashier', () => {
  const delivery = (over: Partial<{ status: string; amount: string; keys: string[] }> = {}) => {
    const { stub } = kashier();
    stub.sessions.set('ORD-1-aaaaaaaaaa', {
      id: 'ks_1',
      order: 'ORD-1-aaaaaaaaaa',
      amount: '123.45',
      state: 'PENDING',
      refunds: [],
      transactionId: null,
    });
    return stub.webhookFor('ORD-1-aaaaaaaaaa', {
      status: over.status ?? 'SUCCESS',
      amount: over.amount ?? '123.45',
      transactionId: 'ktx_1',
      signatureKeys: over.keys,
    });
  };
  const resign = (raw: string, keys: string[]) => {
    const body = JSON.parse(raw);
    body.data.signatureKeys = keys;
    return {
      rawBody: JSON.stringify(body),
      headers: {
        [KASHIER_SIGNATURE_HEADER]: kashierSignature(body.data, keys, KASHIER_STUB.apiKey),
      },
    };
  };

  it('a delivery whose signatureKeys leave out the AMOUNT is refused, however valid its signature', () => {
    const { provider } = kashier();
    const good = delivery();
    // The attacker signs a harmless subset with the (leaked or guessed) key, and changes the amount.
    const body = JSON.parse(good.rawBody);
    body.data.amount = '0.01';
    const forged = resign(JSON.stringify(body), ['merchantOrderId', 'currency', 'status']);
    expect(sync(() => provider.verifyWebhook(forged.rawBody, forged.headers, kashierCreds))).toBe(
      'WEBHOOK_BAD_SIGNATURE'
    );
  });

  it.each(['merchantOrderId', 'amount', 'currency', 'status', 'transactionId'])(
    'signatureKeys must cover %s',
    key => {
      const { provider } = kashier();
      const keys = ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'].filter(
        k => k !== key
      );
      const d = resign(delivery().rawBody, keys);
      expect(sync(() => provider.verifyWebhook(d.rawBody, d.headers, kashierCreds))).toBe(
        'WEBHOOK_BAD_SIGNATURE'
      );
    }
  );

  it('the order of signatureKeys in the payload does not matter (they are sorted)', () => {
    const { provider } = kashier();
    const keys = ['status', 'merchantOrderId', 'transactionId', 'currency', 'amount'];
    const d = resign(delivery().rawBody, keys);
    expect(provider.verifyWebhook(d.rawBody, d.headers, kashierCreds).kind).toBe('payment');
  });

  it.each([
    ['amount', (d: any) => (d.amount = '1.00')],
    ['status', (d: any) => (d.status = 'FAILED')],
    ['merchantOrderId', (d: any) => (d.merchantOrderId = 'ORD-9-bbbbbbbbbb')],
    ['currency', (d: any) => (d.currency = 'USD')],
    ['transactionId', (d: any) => (d.transactionId = 'other')],
  ])('a changed %s fails verification', (_f, mutate) => {
    const { provider } = kashier();
    const good = delivery();
    const body = JSON.parse(good.rawBody);
    mutate(body.data);
    expect(
      sync(() => provider.verifyWebhook(JSON.stringify(body), good.headers, kashierCreds))
    ).toBe('WEBHOOK_BAD_SIGNATURE');
  });

  it('values are URL-encoded into the signed text, so a value with & or = cannot smuggle a field', () => {
    const data = { a: 'x&amount=1', b: 'y' };
    expect(kashierSignature(data, ['a', 'b'], 'k')).not.toBe(
      kashierSignature({ a: 'x', amount: '1', b: 'y' }, ['a', 'amount', 'b'], 'k')
    );
  });

  it('`event` is unsigned: a relabelled delivery keeps the SAME event id, so the inbox drops it as a replay', () => {
    const { provider } = kashier();
    const good = delivery({ status: 'SUCCESS' });
    const original = provider.verifyWebhook(good.rawBody, good.headers, kashierCreds);
    const body = JSON.parse(good.rawBody);
    body.event = 'refund'; // an attacker relabels a genuine PAYMENT delivery (outside the signature)
    const relabelled = provider.verifyWebhook(JSON.stringify(body), good.headers, kashierCreds);
    expect(relabelled.kind).toBe('refund');
    expect(relabelled.eventId).toBe(original.eventId);
  });

  it('an `idempotency` replay marker or an unknown event is refused, never guessed into a payment', () => {
    const { provider } = kashier();
    const good = delivery();
    for (const event of ['idempotency', 'mystery']) {
      const body = JSON.parse(good.rawBody);
      body.event = event;
      expect(
        sync(() => provider.verifyWebhook(JSON.stringify(body), good.headers, kashierCreds))
      ).toBe('WEBHOOK_MALFORMED');
    }
  });

  it('the webhook key is the webhook secret when set, else the Payment API key', () => {
    const { provider } = kashier();
    const good = delivery();
    const withSecret = { ...kashierCreds, webhookSecret: 'only-this-one' };
    expect(sync(() => provider.verifyWebhook(good.rawBody, good.headers, withSecret))).toBe(
      'WEBHOOK_BAD_SIGNATURE'
    );
    expect(provider.verifyWebhook(good.rawBody, good.headers, kashierCreds).kind).toBe('payment');
  });

  it('refuses to create a payment without the merchant id or the secret key', async () => {
    const { provider } = kashier();
    expect(
      await code(provider.createPayment(baseRequest(), { ...kashierCreds, merchantId: undefined }))
    ).toBe('PROVIDER_MISCONFIGURED');
    expect(
      await code(provider.createPayment(baseRequest(), { ...kashierCreds, secretKey: undefined }))
    ).toBe('PROVIDER_MISCONFIGURED');
  });
});

// ---------------------------------------------------------------------------------------------
// FAWRY
// ---------------------------------------------------------------------------------------------
describe('Fawry', () => {
  const paid = async () => {
    const { stub, provider } = fawry();
    const created = await provider.createPayment(baseRequest({ amountMinor: 15_050 }), fawryCreds);
    stub.capture(created.providerRef);
    return { stub, provider, created };
  };

  it('PayAtFawry returns the reference code; CARD returns a hosted redirect; the method is chosen per request', async () => {
    const { provider } = fawry();
    const ref = await provider.createPayment(baseRequest(), fawryCreds);
    expect(ref.instruction.kind).toBe('reference-code');
    if (ref.instruction.kind === 'reference-code') expect(ref.instruction.code).toMatch(/^\d{10}$/);
    expect(ref.invoiceId).toBe(
      ref.instruction.kind === 'reference-code' ? ref.instruction.code : ''
    );
    const card = await provider.createPayment(
      baseRequest({ metadata: { method: 'card' } }),
      fawryCreds
    );
    expect(card.instruction.kind).toBe('redirect');
    const disabled = { ...fawryCreds, settings: { methods: ['payatfawry'] } };
    expect(
      await code(provider.createPayment(baseRequest({ metadata: { method: 'card' } }), disabled))
    ).toBe('PROVIDER_MISCONFIGURED');
  });

  it.each([
    ['paymentAmount', (b: any) => (b.paymentAmount = 1)],
    ['orderAmount', (b: any) => (b.orderAmount = 1)],
    ['orderStatus', (b: any) => (b.orderStatus = 'FAILED')],
    ['fawryRefNumber', (b: any) => (b.fawryRefNumber = '1')],
    ['merchantRefNumber', (b: any) => (b.merchantRefNumber = 'other')],
    ['paymentMethod', (b: any) => (b.paymentMethod = 'CARD')],
  ])('a changed %s fails verification (the messageSignature covers it)', async (_f, mutate) => {
    const { stub, provider, created } = await paid();
    const w = stub.notificationFor(created.providerRef, {
      orderStatus: 'PAID',
      paymentAmountMinor: 15_050,
    });
    const body = JSON.parse(w.rawBody);
    mutate(body);
    expect(sync(() => provider.verifyWebhook(JSON.stringify(body), {}, fawryCreds))).toBe(
      'WEBHOOK_BAD_SIGNATURE'
    );
  });

  it('the notification amounts are signed in canonical 2-dp text, so 100 and 100.0 and 100.00 all verify', async () => {
    const { stub, provider, created } = await paid();
    const w = stub.notificationFor(created.providerRef, {
      orderStatus: 'PAID',
      paymentAmountMinor: 15_000,
      orderAmountMinor: 15_000,
    });
    for (const written of [150, 150.0, '150', '150.00']) {
      const body = JSON.parse(w.rawBody);
      body.paymentAmount = written;
      body.orderAmount = written;
      expect(provider.verifyWebhook(JSON.stringify(body), {}, fawryCreds).kind).toBe('payment');
    }
  });

  it('the signature formula is SHA-256(ref + merchantRef + paymentAmount + orderAmount + status + method + paymentRefrenceNumber + secureKey)', () => {
    const sig = fawryNotificationSignature(
      {
        fawryRefNumber: '931',
        merchantRefNumber: 'ORD-1-x',
        orderStatus: 'PAID',
        paymentMethod: 'PAYATFAWRY',
        paymentAmountMinor: 12_345,
        orderAmountMinor: 12_345,
        paymentRefrenceNumber: 'p-1',
      },
      'KEY'
    );
    const manual = crypto
      .createHash('sha256')
      .update('931' + 'ORD-1-x' + '123.45' + '123.45' + 'PAID' + 'PAYATFAWRY' + 'p-1' + 'KEY')
      .digest('hex');
    expect(sig).toBe(manual);
  });

  it('a refund notification reports NO amount (nothing signed says how much), so the pipeline holds it for a human', async () => {
    const { stub, provider, created } = await paid();
    const w = stub.notificationFor(created.providerRef, {
      orderStatus: 'PARTIAL_REFUNDED',
      paymentAmountMinor: 15_050,
    });
    const ev = provider.verifyWebhook(w.rawBody, {}, fawryCreds);
    expect(ev).toMatchObject({ kind: 'refund', amountMinor: 0 });
  });

  it('event identity uses only signed fields: an unsigned requestId cannot make a replay look new', async () => {
    const { stub, provider, created } = await paid();
    const w = stub.notificationFor(created.providerRef, {
      orderStatus: 'PAID',
      paymentAmountMinor: 15_050,
    });
    const a = JSON.parse(w.rawBody);
    const b = { ...a, requestId: 'a-completely-different-request-id' };
    expect(provider.verifyWebhook(JSON.stringify(a), {}, fawryCreds).eventId).toBe(
      provider.verifyWebhook(JSON.stringify(b), {}, fawryCreds).eventId
    );
  });

  it('a status call for an unknown merchant reference is PAYMENT_NOT_FOUND', async () => {
    const { provider } = fawry();
    expect(await code(provider.getStatus('ORD-nope', fawryCreds))).toBe('PAYMENT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------------------------
// ALL THREE: idempotency
// ---------------------------------------------------------------------------------------------
describe('idempotency on the same key', () => {
  it.each([
    ['paymob', () => paymob(), paymobCreds, (s: any) => s.createdCount],
    ['kashier', () => kashier(), kashierCreds, (s: any) => s.createdCount],
    ['fawry', () => fawry(), fawryCreds, (s: any) => s.createdCount],
  ] as const)(
    '%s: two concurrent creates with one key make ONE payment at the gateway',
    async (_n, make, creds, count) => {
      const { stub, provider } = make();
      const req = baseRequest();
      const [a, b] = await Promise.all([
        provider.createPayment(req, creds),
        provider.createPayment({ ...req }, creds),
      ]);
      expect(b.providerRef).toBe(a.providerRef);
      expect(count(stub)).toBe(1);
    }
  );

  it('two merchants using the same key do not share a slot', async () => {
    const { stub, provider } = paymob();
    const req = baseRequest();
    const other = { ...paymobCreds, apiKey: 'a-different-merchant' };
    await provider.createPayment(req, paymobCreds);
    // the second merchant's key is refused by the stub (401) but must not return the first's payment
    expect(await code(provider.createPayment({ ...req }, other))).toBe('PROVIDER_MISCONFIGURED');
    expect(stub.createdCount).toBe(1);
  });
});
