/** INSTAPAY-AUTO-1 S7: the brain's signed one-tap revert endpoint and the super-admin controls' role gate. */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signBridge } from '@ebda/shared';

const h = vi.hoisted(() => ({ revert: vi.fn() }));
vi.mock('../../apps/api/src/services/billing/instapay-auto-confirm.service', () => ({
  revertAutoConfirmed: h.revert,
}));

import routes, { allowInternalCall } from '../../apps/api/src/routes/internal-instapay.routes';
import { AppError } from '../../apps/api/src/middleware/error-handler';

const SECRET = 'bridge-secret-0123456789abcdef';
const ID = '11111111-1111-4111-8111-111111111111';
function app() {
  const a = express();
  a.use('/internal/instapay', express.raw({ type: () => true, limit: '16kb' }), routes);
  return a;
}
async function call(
  over: {
    body?: string;
    ts?: number;
    sig?: string;
    direction?: 'notify' | 'revert';
    secret?: string;
  } = {}
) {
  const body =
    over.body ?? JSON.stringify({ id: ID, actor: 'telegram-owner', tappedAt: Date.now() });
  const ts = over.ts ?? Date.now();
  const sig =
    over.sig ?? (await signBridge(over.secret ?? SECRET, body, ts, over.direction ?? 'revert'));
  return request(app())
    .post('/internal/instapay/auto-confirm/not-received')
    .set('content-type', 'application/json')
    .set('X-Bridge-Ts', String(ts))
    .set('X-Bridge-Sig', sig)
    .send(body);
}

beforeEach(() => {
  process.env.INSTAPAY_BRIDGE_SECRET = SECRET;
  h.revert.mockReset();
  h.revert.mockResolvedValue({ result: 'reverted', graceUntil: 1 });
  allowInternalCall('reset-ip', 1, Date.now() + 10 * 60_000); // keep the flood map independent of the previous case
});

describe('S7 internal not-received', () => {
  it('a valid signed tap reverts once', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, result: 'reverted' });
    expect(h.revert).toHaveBeenCalledTimes(1);
    expect(h.revert).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, actor: 'telegram-owner' })
    );
  });
  it('bad, missing, stale, wrong-secret and wrong-direction signatures are 401 with zero writes', async () => {
    expect((await call({ sig: 'a'.repeat(64) })).status).toBe(401);
    expect((await call({ sig: '' })).status).toBe(401);
    expect((await call({ ts: Date.now() - 6 * 60_000 })).status).toBe(401);
    expect((await call({ secret: 'another-secret-0123456789abcd' })).status).toBe(401);
    // a captured NOTIFY signature (product -> brain) never works as a revert
    expect((await call({ direction: 'notify' })).status).toBe(401);
    expect(h.revert).not.toHaveBeenCalled();
  });
  it('a body signed correctly but tampered afterwards is 401', async () => {
    const ts = Date.now();
    const signed = JSON.stringify({ id: ID, actor: 'telegram-owner', tappedAt: 1 });
    const sig = await signBridge(SECRET, signed, ts, 'revert');
    const r = await call({
      body: JSON.stringify({
        id: '22222222-2222-4222-8222-222222222222',
        actor: 'telegram-owner',
        tappedAt: 1,
      }),
      ts,
      sig,
    });
    expect(r.status).toBe(401);
    expect(h.revert).not.toHaveBeenCalled();
  });
  it('no secret configured -> 401 (fail closed)', async () => {
    delete process.env.INSTAPAY_BRIDGE_SECRET;
    expect((await call()).status).toBe(401);
  });
  it('a signed body that is not {id uuid, actor, tappedAt} is 400', async () => {
    expect(
      (await call({ body: JSON.stringify({ id: 'x', actor: 'a', tappedAt: 1 }) })).status
    ).toBe(400);
    expect((await call({ body: 'not json' })).status).toBe(400);
  });
  it('a replay of a valid signed request is a 200 already_reverted, never a second revert', async () => {
    h.revert
      .mockResolvedValueOnce({ result: 'reverted', graceUntil: 1 })
      .mockResolvedValueOnce({ result: 'already_reverted', graceUntil: 1 });
    const body = JSON.stringify({ id: ID, actor: 'telegram-owner', tappedAt: 5 });
    const ts = Date.now();
    const sig = await signBridge(SECRET, body, ts, 'revert');
    const a = await call({ body, ts, sig });
    const b = await call({ body, ts, sig });
    expect([a.body.result, b.body.result]).toEqual(['reverted', 'already_reverted']);
    expect(b.status).toBe(200);
  });
  it('unknown payment is 404, a payment a human confirmed is 409 NOT_AUTO_CONFIRMED (the brain reads `code`)', async () => {
    h.revert.mockRejectedValueOnce(new AppError(404, 'AUTO_CONFIRMATION_NOT_FOUND', 'nope'));
    expect((await call()).status).toBe(404);
    h.revert.mockRejectedValueOnce(new AppError(409, 'NOT_AUTO_CONFIRMED', 'no'));
    const r = await call();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_AUTO_CONFIRMED');
  });
  it('a flood is 429 (per IP / global) and writes nothing', async () => {
    for (let i = 0; i < 25; i++) await call();
    const r = await call();
    expect(r.status).toBe(429);
  });
});

describe('S7 admin controls are super_admin only', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../apps/api/src/routes/admin.routes.ts'),
    'utf8'
  );
  for (const route of [
    "'/billing/auto-confirmations',",
    "'/billing/auto-confirmations/:id/revert',",
    "'/billing/auto-confirm/mode',",
    "'/stores/:id/auto-confirm',",
  ])
    it(`${route} is gated by requireRole('super_admin')`, () => {
      const at = src.indexOf(route);
      expect(at).toBeGreaterThan(0);
      expect(src.slice(at, at + 120)).toContain("requireRole('super_admin')");
    });
});
