/**
 * SEC-15 / M-137: a guest order is readable in full only with its signed view token.
 * Red if: verify accepts a tampered / expired / other-order token, the masked view leaks the
 * address or phone, or the route stops asking for the token.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

beforeAll(() => {
  process.env.ORDER_VIEW_SECRET = 'test-order-view-secret';
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('order view token', () => {
  it('accepts its own fresh token and nothing else', async () => {
    const { signOrderViewToken, verifyOrderViewToken, ORDER_VIEW_TTL_MS } =
      await import('@api/lib/order-view-token');
    const t = signOrderViewToken(A);
    expect(verifyOrderViewToken(t, A)).toBe(true);
    expect(verifyOrderViewToken(t, B)).toBe(false); // bound to the order
    expect(verifyOrderViewToken(t, A, Date.now() + ORDER_VIEW_TTL_MS + 5000)).toBe(false); // expired
    const [id, exp, sig] = t.split('.');
    expect(verifyOrderViewToken(`${id}.${Number(exp) + 100000}.${sig}`, A)).toBe(false); // exp edited
    expect(verifyOrderViewToken(`${id}.${exp}.${sig.slice(0, -2)}AA`, A)).toBe(false); // sig edited
    for (const bad of [undefined, null, '', 'x', `${A}.1.2`, 42, `${B}.${exp}.${sig}`]) {
      expect(verifyOrderViewToken(bad, A)).toBe(false);
    }
  });
});

describe('maskGuestOrderView is an allowlist', () => {
  it('drops every field that is not explicitly allowed', async () => {
    const { maskGuestOrderView } = await import('@api/services/gold-rate/public');
    const order = {
      id: A,
      orderNumber: 'EB-1',
      status: 'pending',
      paymentStatus: 'unpaid',
      currency: 'EGP',
      createdAt: '2026-10-26T00:00:00Z',
      total: 12345,
      subtotal: 12000,
      shipping: 345,
      items: [
        {
          id: 'i1',
          productId: 'p1',
          quantity: 2,
          price: 6000,
          personalisation: 'for Mona',
          costPrice: 1,
        },
      ],
      payments: [
        { provider: 'cod', method: null, transactionId: 'T-SECRET', rawResponse: { a: 1 } },
      ],
      customerNotes: 'leave at door, flat 4',
      notes: 'internal note',
      extraAmountNote: 'extra for sofa',
      instapay: { receiptId: 'r1', payerName: 'Mona Hassan' },
      guestEmail: 'buyer@example.com',
      customerEmail: 'buyer@example.com',
      customerPhone: '01012345678',
      futureField: 'anything new',
      shippingAddress: {
        firstName: 'Mona',
        lastName: 'Hassan',
        address1: '12 Tahrir St, flat 4',
        city: 'Cairo',
        state: 'Cairo',
        country: 'EG',
        phone: '01012345678',
      },
      billingAddress: { firstName: 'Mona', address1: '12 Tahrir St' },
    };
    const masked = maskGuestOrderView(order);
    const json = JSON.stringify(masked);
    for (const secret of [
      'Mona',
      'Hassan',
      'Tahrir',
      '01012345678',
      'buyer@example.com',
      'leave at door',
      'internal note',
      'extra for sofa',
      'receiptId',
      'T-SECRET',
      'anything new',
      'for Mona',
      'costPrice',
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    const ALLOWED_TOP = new Set([
      'id',
      'orderNumber',
      'status',
      'paymentStatus',
      'currency',
      'createdAt',
      'total',
      'subtotal',
      'shipping',
      'discount',
      'codFee',
      'tax',
      'taxIncludedInPrice',
      'walletAmount',
      'items',
      'payments',
      'shippingAddress',
      'viewMasked',
    ]);
    for (const k of Object.keys(masked)) expect(ALLOWED_TOP.has(k), k).toBe(true);
    expect(masked).toMatchObject({ total: 12345, orderNumber: 'EB-1', viewMasked: true });
    expect(masked.shippingAddress).toEqual({ city: 'Cairo', state: 'Cairo', country: 'EG' });
    expect(masked.payments).toEqual([{ provider: 'cod', method: null }]);
    expect((masked.items as object[])[0]).toEqual({
      id: 'i1',
      productId: 'p1',
      quantity: 2,
      price: 6000,
    });
    expect(order.shippingAddress.address1).toBe('12 Tahrir St, flat 4');
  });
});

describe('SEC-15 follow-ups', () => {
  it('requestHoldsOrderViewToken never throws and is false without a valid header', async () => {
    const { requestHoldsOrderViewToken, signOrderViewToken } =
      await import('@api/lib/order-view-token');
    const req = (h?: string) => ({ get: () => h });
    expect(requestHoldsOrderViewToken(req(undefined), A)).toBe(false);
    expect(requestHoldsOrderViewToken(req('garbage'), A)).toBe(false);
    expect(requestHoldsOrderViewToken(req(signOrderViewToken(A)), A)).toBe(true);
    const saved = process.env.ORDER_VIEW_SECRET;
    delete process.env.ORDER_VIEW_SECRET;
    const savedKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() =>
        requestHoldsOrderViewToken(req(`${A}.9999999999.${'a'.repeat(43)}`), A)
      ).not.toThrow();
    } finally {
      process.env.ORDER_VIEW_SECRET = saved;
      if (savedKey !== undefined) process.env.ENCRYPTION_KEY = savedKey;
    }
  });
  it('maskReceiptPayerPii nulls the payer identity but keeps amount, reference and flags', async () => {
    const { maskReceiptPayerPii } =
      await import('@api/services/payment-providers/instapay-receipt.service');
    const r = {
      id: 'r1',
      flags: ['LOOKS_EDITED'],
      extracted: {
        amountMinor: 100,
        reference: '123',
        payerName: 'Mona',
        payerAddress: 'm@instapay',
        payerMobile: '0100',
        payerBank: 'CIB',
      },
      fields: {
        amountMinor: 100,
        reference: '123',
        payerName: 'Mona',
        payerAddress: 'm@instapay',
        payerMobile: '0100',
        payerBank: 'CIB',
      },
    };
    const m = maskReceiptPayerPii(r);
    expect(JSON.stringify(m)).not.toMatch(/Mona|instapay|0100|CIB/);
    expect(m.fields).toMatchObject({ amountMinor: 100, reference: '123' });
    expect(m.flags).toEqual(['LOOKS_EDITED']);
  });
  it('the instapay GETs and the order GET use the token gate and send no-store', () => {
    const pay = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/routes/payment.routes.ts'),
      'utf8'
    );
    expect(pay).toContain('maskReceiptPayerPii(receipt)');
    expect(pay).toMatch(/requestHoldsOrderViewToken\(req, orderId\)\s*\?\s*receipt/);
    expect(pay).toContain('receiptId: null');
    const pub = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/routes/public.routes.ts'),
      'utf8'
    );
    expect(pub).toContain("res.vary('X-Order-View-Token')");
    expect(pub).toContain('checkoutIp: _ip');
  });
});

describe('route wiring', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../apps/api/src/routes/public.routes.ts'),
    'utf8'
  );
  // GET /orders/:id masking is exercised against the real handler in guest-order-route-token.test.ts
  it('POST /orders hands a guest the token', () => {
    expect(src).toContain('viewToken: guestViewTokenFor(order.id)');
    expect(src).toContain('return signOrderViewToken(orderId);');
  });
});

describe('TEN-5: InstaPay receipt upload + submit need the order view token', () => {
  const run = async (orderId: string, header?: string) => {
    const { requireOrderAccess } = await import('@api/lib/order-view-token');
    let status = 0;
    let body: { error?: { code?: string } } = {};
    let nexted = false;
    await requireOrderAccess(async () => false)(
      {
        get: (n: string) => (n.toLowerCase() === 'x-order-view-token' ? header : undefined),
        params: { orderId },
      },
      {
        status(c: number) {
          status = c;
          return { json: (b: unknown) => void (body = b as typeof body) };
        },
      },
      () => {
        nexted = true;
      }
    );
    return { status, body, nexted };
  };

  it('403s with no token, a wrong-order token, and passes with the order token', async () => {
    const { signOrderViewToken } = await import('@api/lib/order-view-token');
    const none = await run(A);
    expect(none.status).toBe(403);
    expect(none.body.error?.code).toBe('ORDER_VIEW_TOKEN_REQUIRED');
    expect(none.nexted).toBe(false);
    expect((await run(A, signOrderViewToken(B))).nexted).toBe(false);
    expect((await run(A, signOrderViewToken(A))).nexted).toBe(true);
  });

  describe('INSTAPAY-UPLOAD-1: the owning signed-in customer is accepted too', () => {
    const call = async (
      orderId: string,
      opts: {
        header?: string;
        user?: { role?: string; userId?: string };
        owns?: (c: string, o: string) => Promise<boolean>;
      }
    ) => {
      const { requireOrderAccess } = await import('@api/lib/order-view-token');
      let status = 0;
      let nexted = false;
      await requireOrderAccess(opts.owns ?? (async () => false))(
        {
          get: (n: string) => (n.toLowerCase() === 'x-order-view-token' ? opts.header : undefined),
          params: { orderId },
          user: opts.user,
        },
        {
          status(c: number) {
            status = c;
            return { json: () => undefined };
          },
        },
        () => {
          nexted = true;
        }
      );
      return { status, nexted };
    };
    const owner = { role: 'customer', userId: 'cust-1' };
    const ownsA = async (c: string, o: string) => c === 'cust-1' && o === A;

    it('lets the owning customer through with no token', async () => {
      expect((await call(A, { user: owner, owns: ownsA })).nexted).toBe(true);
    });
    it("refuses another customer's order, a guest, a non-customer role and an unowned order", async () => {
      expect((await call(B, { user: owner, owns: ownsA })).status).toBe(403);
      expect(
        (await call(A, { user: { role: 'customer', userId: 'cust-2' }, owns: ownsA })).status
      ).toBe(403);
      expect((await call(A, { owns: ownsA })).status).toBe(403);
      expect(
        (await call(A, { user: { role: 'store_admin', userId: 'cust-1' }, owns: ownsA })).status
      ).toBe(403);
    });
    it('fails closed when the ownership lookup throws', async () => {
      const r = await call(A, {
        user: owner,
        owns: async () => {
          throw new Error('db down');
        },
      });
      expect(r).toEqual({ status: 403, nexted: false });
    });
    it('the view token still passes without any lookup', async () => {
      const { signOrderViewToken } = await import('@api/lib/order-view-token');
      let looked = false;
      const r = await call(A, {
        header: signOrderViewToken(A),
        owns: async () => {
          looked = true;
          return false;
        },
      });
      expect(r.nexted).toBe(true);
      expect(looked).toBe(false);
    });
  });

  it('both write routes mount the guard before the handler (and upload before multer)', () => {
    const pay = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/routes/payment.routes.ts'),
      'utf8'
    );
    expect(pay).toMatch(
      /'\/instapay\/:orderId\/receipt',\s*optionalAuthenticate,\s*rejectImpersonated,\s*paymentLimiter,\s*requireInstapayOrderAccess[^\n]*\n\s*uploadLimiter/
    );
    expect(pay).toMatch(
      /'\/instapay\/:orderId\/receipt\/:receiptId\/submit',\s*optionalAuthenticate,\s*rejectImpersonated,\s*paymentLimiter,\s*requireInstapayOrderAccess/
    );
  });
});
