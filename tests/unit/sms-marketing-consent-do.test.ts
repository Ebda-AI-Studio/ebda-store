/**
 * Ported from the consent-service half of tests/integration/sms-marketing-consent.test.ts (Postgres). The real SmsConsentService runs on the
 * StoreDO schema (node:sqlite through prisma-lite, the wiring of product-3d-models-do.test.ts), one database PER STORE as in production, so
 * "another store's consent does not count" is the per-store DO boundary plus the service's own storeId filter. Proves: the promotional-SMS gate
 * read (`findActiveForPhone`) matches a phone across formats and only on a GRANTED row; a withdrawal is phone-wide (own row + guest rows for the
 * same phone); a later grant on another key outranks the account's own withdrawn row (issue 2423); a guest opt-in shows on the account the same
 * phone registers later and in the admin list; the surfaces read the same rows the gate does; the opt-out token round-trips and a tampered one is
 * refused. Not ported (they need the dispatcher, whose locale / storefront-base reads are still Prisma, or Postgres-only wiring): the
 * dispatcher gate cases, the account / unsubscribe routes, the checkout box, the GDPR export/erase and the opt-out base cache (see the PR notes).
 */
import { describe, it, expect, vi } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const dbs = { [A]: openSqlite(), [B]: openSqlite() } as Record<
  string,
  ReturnType<typeof openSqlite>
>;
const lites = Object.fromEntries(
  Object.entries(dbs).map(([k, d]) => [
    k,
    createPrismaLite(META, nodeSqlRunner(d), 'store-do', { unscoped: true }) as any,
  ])
) as Record<string, any>;

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async (id: string) => lites[id],
  storeWriter: async (id: string) => lites[id],
  storeRepo: async () => ({ backend: 'do' }),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: prisma.${String(p)}`);
        },
      }
    ),
  })
);

import { SmsConsentService } from '../../apps/api/src/services/sms-consent.service';
import {
  signSmsOptOutToken,
  verifySmsOptOutToken,
  SMS_OPT_OUT_TOKEN_V3_LENGTH,
} from '../../apps/api/src/lib/sms-consent';

let n = 0;
/** A distinct Egyptian mobile (local form) per call. */
const egMobile = () => `010${String(10_000_000 + ++n).padStart(8, '0')}`;
const egKey = (local: string) => `20${local.slice(1)}`;
const spaced = (l: string) => `+20 ${l.slice(1, 4)} ${l.slice(4, 8)} ${l.slice(8)}`;
const uid = () => `u-${++n}`;

describe('SMS marketing consent service on the StoreDO schema (issue 206)', () => {
  it('no consent -> no gate row; a granted consent is matched across phone formats', async () => {
    const phone = egMobile();
    expect(await SmsConsentService.findActiveForPhone(A, phone)).toBeNull();
    await SmsConsentService.recordGrant(A, {
      customerKey: spaced(phone),
      phone: spaced(phone),
      source: 'checkout',
    });
    expect(await SmsConsentService.findActiveForPhone(A, phone)).not.toBeNull();
    expect(await SmsConsentService.findActiveForPhone(A, `+${egKey(phone)}`)).not.toBeNull();
    expect(await SmsConsentService.findActiveForPhone(A, null)).toBeNull();
  });

  it('withdrawn consent -> no gate row, even with an older granted guest row for the same phone (phone-wide)', async () => {
    const phone = egMobile();
    await SmsConsentService.recordGrant(A, { customerKey: phone, phone, source: 'checkout' });
    await SmsConsentService.recordGrant(A, {
      customerKey: `guest-${uid()}@example.test`,
      phone: egKey(phone),
      source: 'checkout',
    });
    expect(await SmsConsentService.revoke(A, { phone }, 'account')).toBe(2);
    expect(await SmsConsentService.findActiveForPhone(A, phone)).toBeNull();
    expect(await SmsConsentService.revoke(A, { phone }, 'account')).toBe(0); // nothing left to flip
  });

  it("another store's consent does not count", async () => {
    const phone = egMobile();
    await SmsConsentService.recordGrant(A, { customerKey: phone, phone, source: 'checkout' });
    expect(await SmsConsentService.findActiveForPhone(B, phone)).toBeNull();
    expect(await SmsConsentService.revoke(B, { phone }, 'account')).toBe(0);
    expect(await SmsConsentService.findActiveForPhone(A, phone)).not.toBeNull(); // B's withdrawal never touched A
  });

  it('a regrant on the same key is one row (upsert), granted again and attributed to the new source', async () => {
    const phone = egMobile();
    await SmsConsentService.recordGrant(A, { customerKey: phone, phone, source: 'checkout' });
    await SmsConsentService.revoke(A, { phone }, 'unsubscribe');
    await SmsConsentService.recordGrant(A, {
      customerKey: phone,
      phone,
      source: 'account',
      userId: 'user-x',
    });
    expect((await SmsConsentService.getForCustomerKey(A, phone)).status).toBe('granted');
    expect(
      dbs[A]!.prepare(
        `SELECT count(*) AS n FROM sms_marketing_consents WHERE customer_key = ?`
      ).get(phone)
    ).toEqual({ n: 1 });
  });

  it('admin: the profile view and the list rows carry the consent status; the same key in another store is a different customer', async () => {
    const phone = egMobile();
    const key = `list-${uid()}@example.test`;
    await SmsConsentService.recordGrant(A, { customerKey: key, phone, source: 'checkout' });
    const view = await SmsConsentService.getForCustomerKey(A, key);
    expect(view).toMatchObject({ status: 'granted', grantedSource: 'checkout' });
    expect(view.grantedAt).toBeInstanceOf(Date);
    const map = await SmsConsentService.statusForKeys(A, [
      { key, phone },
      { key: 'nobody', phone: null },
    ]);
    expect(map.get(key)).toBe('granted');
    expect(map.get('nobody')).toBeUndefined();
    expect((await SmsConsentService.getForCustomerKey(B, key)).status).toBe('none');
  });

  it('a guest opt-in shows on the account the same phone registers later, and withdrawing from the account withdraws what the gate reads (issue 2423)', async () => {
    const phone = egMobile();
    await SmsConsentService.recordGrant(A, {
      customerKey: `guest-${uid()}@example.test`,
      phone: `+20${phone.slice(1)}`,
      source: 'checkout',
    });
    const shopperId = uid(); // the same person registers: customerKeyOf is now the user id
    expect(await SmsConsentService.findActiveForPhone(A, phone)).not.toBeNull(); // the gate sends to this phone
    expect(await SmsConsentService.getForCustomerKey(A, shopperId, phone)).toMatchObject({
      status: 'granted',
      grantedSource: 'checkout',
    });
    expect(
      (await SmsConsentService.statusForKeys(A, [{ key: shopperId, phone }])).get(shopperId)
    ).toBe('granted');
    expect(await SmsConsentService.revoke(A, { phone, userId: shopperId }, 'account')).toBe(1);
    expect(await SmsConsentService.findActiveForPhone(A, phone)).toBeNull();
    expect(await SmsConsentService.getForCustomerKey(A, shopperId, phone)).toMatchObject({
      status: 'revoked',
      revokedSource: 'account',
    });
    expect(
      (await SmsConsentService.statusForKeys(A, [{ key: shopperId, phone }])).get(shopperId)
    ).toBe('revoked');
  });

  it("a later grant on another key for the same phone outranks the account's own withdrawn row", async () => {
    const phone = egMobile();
    const shopperId = uid();
    await SmsConsentService.recordGrant(A, {
      customerKey: shopperId,
      userId: shopperId,
      phone,
      source: 'account',
    });
    await SmsConsentService.revoke(A, { phone, userId: shopperId }, 'account');
    await SmsConsentService.recordGrant(A, {
      customerKey: `again-${uid()}@example.test`,
      phone,
      source: 'checkout',
    });
    expect(await SmsConsentService.findActiveForPhone(A, phone)).not.toBeNull();
    expect((await SmsConsentService.getForCustomerKey(A, shopperId, phone)).status).toBe('granted');
    // without the phone the read is the key row alone: what it used to be
    expect((await SmsConsentService.getForCustomerKey(A, shopperId)).status).toBe('revoked');
  });

  it('the opt-out token is a fixed 68 characters, round-trips to the consent id, and a tampered token is refused', () => {
    const token = signSmsOptOutToken('33333333-3333-4333-8333-333333333333', A);
    expect(token).toHaveLength(SMS_OPT_OUT_TOKEN_V3_LENGTH);
    expect(verifySmsOptOutToken(token)).toBe('33333333-3333-4333-8333-333333333333');
    expect(verifySmsOptOutToken(`${token.slice(0, -2)}AA`)).toBeNull();
    expect(verifySmsOptOutToken(42)).toBeNull();
  });
});
