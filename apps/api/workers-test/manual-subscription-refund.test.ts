/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * S3-M1 (audit M1): the super-admin RECORDS a refund or a void of a manual (InstaPay) subscription payment, on the BUILT Worker with
 * the real platform D1 schema and a real DO store. No money moves; the ledger, the paid period and the idempotency are the product:
 *  - a void reverses the whole payment, gives back exactly the time it bought, flips the payment to `refunded`, frees its reference;
 *  - a refund is idempotent on the refund reference (a replay is 200 and changes nothing), partial refunds sum, over-refund is refused;
 *  - only a super-admin may do it (a store admin gets 403); a refunded payment cannot be refunded again.
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  E2E_DB: string;
};
const BASE = 'https://api.ebda.app/api/v1';
let ip = 0;
const call = (method: string, path: string, token: string, body?: unknown) =>
  e.API.fetch(BASE + path, {
    method,
    headers: {
      'cf-connecting-ip': `10.9.0.${ip++ & 255}`,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) =>
  (await r.json()) as { success: boolean; data?: any; error?: { code: string } };

let su = '';
let adminTok = '';
let storeId = '';
const sub = async () =>
  (await e.PLATFORM_DB.prepare(
    `SELECT status, current_period_start AS s, current_period_end AS e FROM store_subscriptions WHERE store_id = ?`
  )
    .bind(storeId)
    .first()) as { status: string; s: number; e: number } | null;
const event = async (id: string) =>
  (await e.PLATFORM_DB.prepare(`SELECT status, amount_minor FROM billing_events WHERE id = ?`)
    .bind(id)
    .first()) as { status: string; amount_minor: number };
const refunds = async (id: string) =>
  (
    await e.PLATFORM_DB.prepare(
      `SELECT amount_minor, status FROM billing_events WHERE related_event_id = ? AND type = 'refund' ORDER BY created_at`
    )
      .bind(id)
      .all()
  ).results as Array<{ amount_minor: number; status: string }>;

let n = 0;
async function pay(reference: string) {
  const r = await call('POST', `/admin/stores/${storeId}/manual-payment`, su, {
    planCode: 'growth',
    interval: 'monthly',
    amountMinor: 100_000,
    method: 'instapay',
    reference,
    paidAt: new Date().toISOString(),
  });
  const body = await json(r);
  expect(r.status, JSON.stringify(body)).toBe(201);
  return body.data.billingEventId as string;
}
const refundBody = (over: Record<string, unknown>) => ({
  refundDate: new Date().toISOString().slice(0, 10),
  note: 'customer asked',
  ...over,
});

describe.skipIf(e.E2E_DB === '1')('S3-M1 manual subscription refund / void', () => {
  it('fixture: a DO store, the plans, a super-admin and a store admin', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
      )
        .bind(
          `plan-${p.code}`,
          p.code,
          p.nameEn,
          p.nameAr,
          p.featureTier,
          JSON.stringify(p.limits),
          p.priceMonthlyMinor,
          p.priceYearlyMinor
        )
        .run();
    for (const [i, k] of [
      'platform_cutover.billing',
      'platform_cutover.access',
      'platform_cutover.platform',
      'platform_cutover.inbox',
      'platform_cutover.ai-usage',
      'platform_cutover.analytics',
      'platform_cutover.payments',
      'platform_cutover.ops',
      'platform_cutover.audit',
      'customer_auth_cutover.__all',
    ].entries())
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
      )
        .bind(`msr-marker-${i}`, k)
        .run();
    const made = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
      method: 'POST',
      body: JSON.stringify({
        ownerId: 'owner-msr',
        name: 'MSR Shop',
        slug: 'msr-shop',
        operator: true,
      }),
    });
    expect(made.status).toBe(200);
    storeId = ((await made.json()) as { id: string }).id;
    for (const u of ['super-msr', 'owner-msr'])
      await authState(`user:tv:${u}`, [['set', `user:tv:${u}`, '0', {}]]);
    su = await accessToken({ userId: 'super-msr', jti: 'j-msr-su', role: 'super_admin' });
    adminTok = await accessToken({
      userId: 'owner-msr',
      jti: 'j-msr-o',
      role: 'store_admin',
      storeId,
    });
  });

  it('a store admin cannot record a refund or a void (403, the ledger is untouched)', async () => {
    const id = await pay('111111111111');
    const r = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      adminTok,
      refundBody({ kind: 'void' })
    );
    expect(r.status).toBe(403);
    expect((await event(id)).status).toBe('succeeded');
    expect(await refunds(id)).toEqual([]);
  });

  it('a VOID reverses the whole payment: refunded, one refund row for the full amount, the period it bought is given back; a replay is 200 and changes nothing', async () => {
    const before = await sub();
    const id = await pay('222222222222');
    const bought = await sub();
    expect(bought!.e).toBeGreaterThan(before?.e ?? 0);
    const r = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      su,
      refundBody({ kind: 'void', note: 'recorded for the wrong store' })
    );
    expect(r.status).toBe(201);
    expect((await event(id)).status).toBe('refunded');
    expect(await refunds(id)).toEqual([{ amount_minor: 100_000, status: 'succeeded' }]);
    expect((await sub())!.e).toBeLessThan(bought!.e);
    const again = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      su,
      refundBody({ kind: 'void', note: 'recorded for the wrong store' })
    );
    expect(again.status).toBe(200);
    expect((await json(again)).data.duplicate).toBe(true);
    expect(await refunds(id)).toHaveLength(1);
  });

  it('refunds are idempotent on the refund reference, sum up, and can never exceed what was paid', async () => {
    const id = await pay('333333333333');
    const body = (ref: string, amountMinor: number) =>
      refundBody({ kind: 'refund', reference: ref, recipientName: 'Demo Merchant', amountMinor });
    const first = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      su,
      body('44444444', 30_000)
    );
    expect(first.status).toBe(201);
    expect((await event(id)).status).toBe('succeeded'); // partial: still a live payment
    const replay = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      su,
      body('44444444', 30_000)
    );
    expect(replay.status).toBe(200);
    expect(await refunds(id)).toHaveLength(1);
    const tooMuch = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      su,
      body('55555555', 80_000)
    );
    expect(tooMuch.status).toBe(400);
    expect((await json(tooMuch)).error?.code).toBe('INVALID_REFUND_AMOUNT');
    expect(
      (
        await call(
          'POST',
          `/admin/billing/events/${id}/manual-refund`,
          su,
          body('66666666', 70_000)
        )
      ).status
    ).toBe(201);
    expect((await event(id)).status).toBe('refunded');
    expect((await refunds(id)).reduce((s, r) => s + r.amount_minor, 0)).toBe(100_000);
    const done = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      su,
      body('77777777', 1)
    );
    expect(done.status).toBe(409);
    expect((await json(done)).error?.code).toBe('ALREADY_REFUNDED');
  });

  it('a refund needs a valid reference and a recipient; a void needs a reason', async () => {
    const id = await pay(`88888888${++n}`.slice(0, 12).padEnd(12, '0'));
    const noRef = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      su,
      refundBody({ kind: 'refund', reference: 'abc', recipientName: 'X' })
    );
    expect(noRef.status).toBe(400);
    expect((await json(noRef)).error?.code).toBe('INVALID_REFERENCE');
    const noName = await call(
      'POST',
      `/admin/billing/events/${id}/manual-refund`,
      su,
      refundBody({ kind: 'refund', reference: '12345678' })
    );
    expect((await json(noName)).error?.code).toBe('RECIPIENT_REQUIRED');
    expect(
      (
        await call(
          'POST',
          `/admin/billing/events/${id}/manual-refund`,
          su,
          refundBody({ kind: 'void', note: 'x' })
        )
      ).status
    ).toBe(400);
    expect(await refunds(id)).toEqual([]);
  });
});
