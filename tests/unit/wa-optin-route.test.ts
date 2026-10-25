/**
 * WA-CONSENT-1: the REAL middleware chain of POST /cart/whatsapp-optin with REAL rate limiters
 * (express-rate-limit, memory store). A flood of anonymous calls consumes nothing and a signed-in
 * buyer's revoke still returns 200; a store-wide grant flood cannot block a revoke either.
 */
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { describe, expect, it, vi } from 'vitest';
import { createWhatsAppOptInHandlers } from '@api/routes/whatsapp-optin';

const S = '11111111-1111-4111-8111-111111111111';

function build(opts: { userMax?: number; storeMax?: number } = {}) {
  const record = vi.fn(async (_s: string, _sess: string, _u: string, i: { consent: boolean }) => ({
    status: 'recorded' as const,
    granted: i.consent,
    cartId: 'cart-1',
  }));
  const audit = vi.fn(async () => undefined);
  // The same shape as production's limiters, with test-sized ceilings.
  const userLimiter = rateLimit({
    windowMs: 60_000,
    max: opts.userMax ?? 5,
    keyGenerator: req => `u:${req.user?.userId ?? 'anon'}`,
    validate: false,
  });
  const storeLimiter = rateLimit({
    windowMs: 60_000,
    max: opts.storeMax ?? 5,
    keyGenerator: (_req, res) => `store:${res.locals.waStoreId}`,
    validate: false,
  });
  const app = express();
  app.use(express.json());
  app.post(
    '/cart/whatsapp-optin',
    ...createWhatsAppOptInHandlers({
      // Token = user id; no token = anonymous (like optionalAuthenticate).
      authenticate: (req, _res, next) => {
        const t = req.headers.authorization?.replace('Bearer ', '');
        if (t) (req as any).user = { userId: t };
        next();
      },
      userLimiter,
      storeLimiter,
      storeIdFor: async () => S,
      isLinked: async () => true,
      record,
      state: async () => ({ granted: true }),
      audit,
    })
  );
  // Keyed on the RESOLVED store id (res.locals.waStoreId), like production.
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err?.name === 'ZodError' ? 400 : 500).json({ success: false })
  );
  return { app, record, audit };
}

const post = (app: express.Express, body: object, user?: string, session = 'sess-1') => {
  const r = request(app).post('/cart/whatsapp-optin').set('x-session-id', session);
  if (user) r.set('Authorization', `Bearer ${user}`);
  return r.send(body);
};

describe('POST /cart/whatsapp-optin', () => {
  it('a flood of anonymous requests exhausts nothing: a signed-in buyer can still revoke (200)', async () => {
    const { app, record } = build();
    for (let i = 0; i < 40; i++) {
      const r = await post(app, { consent: true });
      expect(r.status).toBe(401);
      await post(app, { consent: false });
    }
    expect(record).not.toHaveBeenCalled();
    const revoke = await post(app, { consent: false }, 'buyer-1');
    expect(revoke.status).toBe(200);
    expect(revoke.body.data).toEqual({ granted: false });
  });

  it("a store-wide flood of GRANTS by other customers cannot block a buyer's revoke", async () => {
    const { app } = build({ storeMax: 3, userMax: 50 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++)
      codes.push((await post(app, { consent: true }, `attacker-${i}`)).status);
    expect(codes.filter(c => c === 429).length).toBeGreaterThan(0); // the grant ceiling works
    const revoke = await post(app, { consent: false }, 'buyer-1');
    expect(revoke.status).toBe(200);
  });

  it("one caller's burst is limited per user, and never affects another user", async () => {
    const { app } = build({ userMax: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post(app, { consent: false }, 'chatty')).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3).every(c => c === 429)).toBe(true);
    expect((await post(app, { consent: false }, 'someone-else')).status).toBe(200);
  });

  it('a phone in the body is rejected and never reaches the service', async () => {
    const { app, record } = build();
    const r = await post(app, { consent: true, phone: '01001234567' }, 'buyer-1');
    expect(r.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("the service sees the caller's own user id and session, and the grant is audited with the cart id", async () => {
    const { app, record, audit } = build();
    await post(app, { consent: true, language: 'ar' }, 'buyer-1', 'sess-9');
    expect(record).toHaveBeenCalledWith(S, 'sess-9', 'buyer-1', { consent: true, locale: 'ar' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'whatsapp.marketing_consent_granted',
        resourceId: 'cart-1',
        userId: 'buyer-1',
        details: expect.objectContaining({ source: 'checkout', cartId: 'cart-1' }),
      })
    );
  });

  it('an unproven phone is a clear 400 PHONE_UNPROVEN (the web shows the message)', async () => {
    const { app, record } = build();
    record.mockResolvedValueOnce({ status: 'phone_unproven' } as any);
    const r = await post(app, { consent: true }, 'buyer-1');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PHONE_UNPROVEN');
  });
});
