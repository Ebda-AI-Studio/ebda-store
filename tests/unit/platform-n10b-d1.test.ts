/**
 * NEON-ZERO-1 N-10b: the `platform` and `inbox` families on D1 (settings, features, legal, provider, merchant keys,
 * slug redirects, the payment-webhook inbox), the freeze behaviour of each, and the raw-SQL replacements.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
const pg = vi.hoisted(() => ({ rows: [] as Array<{ id: string }> }));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // the one Postgres read of the freeze path (ebda_webhook_inbox_by_key) is answered by the test
  const prisma = new Proxy(real.prisma, {
    get: (t, p) => (p === '$queryRaw' ? async () => pg.rows : Reflect.get(t, p)),
  });
  return { ...real, prisma };
});

import { prisma } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import {
  cutoverKey,
  freezeKey,
  resetCutoverCache,
} from '../../apps/api/src/services/platform/cutover';
import { registerPlatformRouter, vatGuard } from '../../apps/api/src/services/platform/router';
import {
  inboxGetD1,
  inboxListD1,
  inboxRecordD1,
  inboxStuckD1,
  inboxUpdateD1,
  legalSendRowD1,
  revokeUserMerchantKeysD1,
  sendRowStillExistsD1,
  withdrawLegalSendD1,
} from '../../apps/api/src/services/platform/platform-d1';
import { webhookInbox, withdrawLegalNoticeSend } from '../../apps/api/src/lib/definer';

const MIG = ['0001_init.sql', '0002_invariants.sql']
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
      'utf8'
    )
  )
  .join('\n');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function world(family: 'platform' | 'inbox' | null) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIG);
  const stmt = (sql: string, v: unknown[]) =>
    /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
      ? { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } }
      : { results: [], meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) } };
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...v: unknown[]) => ({
        all: async () => (await Promise.resolve(), stmt(sql, v)),
        run: async () => (await Promise.resolve(), stmt(sql, v)),
        first: async () => (await Promise.resolve(), (stmt(sql, v).results[0] ?? null) as never),
      }),
    }),
  };
  for (const [id, slug] of [
    [A, 'a'],
    [B, 'b'],
  ])
    db.prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, ?, ?, 'o')`).run(
      id,
      slug,
      slug
    );
  if (family)
    db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c', ?, '{}')`).run(
      cutoverKey(family)
    );
  setCfBindings({ PLATFORM_DB: d1 } as never);
  return db;
}
const freeze = (db: DatabaseSync, family: 'platform' | 'inbox') =>
  db
    .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('f', ?, ?)`)
    .run(freezeKey(family), JSON.stringify({ expiresAt: Date.now() + 60_000 }));

beforeEach(() => {
  pg.rows = [];
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
});

describe('platform family on D1 (router)', () => {
  it('settings, features, merchant keys and slug redirects are served by D1', async () => {
    const db = world('platform');
    await prisma.systemSetting.upsert({
      where: { key: 'k' },
      create: { key: 'k', value: { a: 1 } },
      update: { value: { a: 2 } },
    });
    await prisma.systemSetting.upsert({
      where: { key: 'k' },
      create: { key: 'k', value: { a: 1 } },
      update: { value: { a: 2 } },
    });
    expect(await prisma.systemSetting.findUnique({ where: { key: 'k' } })).toMatchObject({
      value: { a: 2 },
    });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_settings WHERE key = 'k'`).get()).toEqual({
      n: 1,
    });

    const f = { storeId_featureKey: { storeId: A, featureKey: 'blog' } };
    await prisma.storeFeature.upsert({
      where: f,
      create: { storeId: A, featureKey: 'blog', enabled: true, enabledBy: 'u' },
      update: { enabled: false },
    });
    await prisma.storeFeature.upsert({
      where: f,
      create: { storeId: A, featureKey: 'blog', enabled: true, enabledBy: 'u' },
      update: { enabled: false },
    });
    expect(
      await prisma.storeFeature.findMany({
        where: { storeId: A },
        select: { featureKey: true, enabled: true },
      })
    ).toEqual([{ featureKey: 'blog', enabled: false }]);

    await prisma.merchantApiKey.create({
      data: { storeId: A, userId: 'u1', name: 'k', keyHash: 'h1', prefix: 'p', scopes: ['read'] },
    });
    expect(await prisma.merchantApiKey.findUnique({ where: { keyHash: 'h1' } })).toMatchObject({
      storeId: A,
      scopes: ['read'],
    });
    expect(
      (
        await prisma.merchantApiKey.updateMany({
          where: { storeId: A, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      ).count
    ).toBe(1);

    await prisma.slugRedirect.create({
      data: { storeId: A, entityType: 'PRODUCT', fromSlug: 'old', toSlug: 'new' },
    });
    expect(
      await prisma.slugRedirect.findFirst({
        where: { storeId: A, entityType: 'PRODUCT', fromSlug: 'old' },
      })
    ).toMatchObject({ toSlug: 'new' });
  });

  it('the freeze refuses writes to the family and not reads', async () => {
    const db = world(null);
    freeze(db, 'platform');
    await expect(
      prisma.storeFeature.upsert({
        where: { storeId_featureKey: { storeId: A, featureKey: 'x' } },
        create: { storeId: A, featureKey: 'x', enabled: true, enabledBy: 'u' },
        update: {},
      })
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('raw replacements (platform)', () => {
  it('legal notice withdraw: one statement that refuses once a delivery exists, a recipient count is set, or the sender differs', async () => {
    const db = world('platform');
    const send = (id: string, over = '') =>
      db
        .prepare(
          `INSERT INTO legal_notice_sends (id, doc_key, version, sent_by, sent_at${over ? ', recipient_count' : ''}) VALUES (?, ?, 'v1', 'op', ?${over ? ', 5' : ''})`
        )
        .run(id, `doc-${id}`, Date.now());
    send('s1');
    expect(await withdrawLegalSendD1('s1', 'someone-else', new Date())).toBe(0);
    send('s2', 'counted');
    expect(await withdrawLegalSendD1('s2', 'op', new Date())).toBe(0);
    send('s3');
    db.prepare(
      `INSERT INTO legal_notice_deliveries (id, user_id, doc_key, version) VALUES ('d', 'u', 'doc-s3', 'v1')`
    ).run();
    expect(await withdrawLegalSendD1('s3', 'op', new Date())).toBe(0);
    expect(await withdrawLegalSendD1('s1', 'op', new Date(Date.now() + 11 * 60_000))).toBe(0); // too old
    expect(await withdrawLegalSendD1('s1', 'op', new Date())).toBe(1);
    expect(await sendRowStillExistsD1('s1')).toBe(false);
    expect(await legalSendRowD1('s2')).toMatchObject({ doc_key: 'doc-s2', recipient_count: 5 });
    // the definer wrapper routes to D1 after the flip and demands the operator id
    expect(await withdrawLegalNoticeSend('s2', 'op')).toBe(0);
    await expect(withdrawLegalNoticeSend('s2')).rejects.toThrow(/operatorId/);
  });

  it("revoking a user's sessions revokes the live merchant keys in every store, once", async () => {
    const db = world('platform');
    for (const [id, store] of [
      ['k1', A],
      ['k2', B],
    ])
      db.prepare(
        `INSERT INTO merchant_api_keys (id, store_id, user_id, name, key_hash, prefix, scopes) VALUES (?, ?, 'u1', 'n', ?, 'p', '[]')`
      ).run(id, store, `h-${id}`);
    expect(await revokeUserMerchantKeysD1('u1', new Date())).toBe(2);
    expect(await revokeUserMerchantKeysD1('u1', new Date())).toBe(0);
  });
});

describe('inbox family', () => {
  const rec = (key: string, over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    provider: 'paymob',
    idempotencyKey: key,
    storeId: A,
    payload: { n: 1 },
    rawBody: 'raw',
    signature: 'sig',
    ...over,
  });

  it('record: first delivery inserts, a redelivery refreshes only an unprocessed row', async () => {
    const db = world('inbox');
    const id1 = await inboxRecordD1(rec('k1'));
    expect(await inboxRecordD1(rec('k1', { payload: { n: 2 }, rawBody: 'raw2' }))).toBe(id1);
    expect(await inboxGetD1(id1)).toMatchObject({
      payload: { n: 2 },
      raw_body: 'raw2',
      status: 'received',
    });
    await inboxUpdateD1(id1, {
      status: 'processed',
      markProcessed: { resultOrderId: 'o1', resultStatus: 'paid' },
    });
    await inboxRecordD1(rec('k1', { payload: { n: 3 }, rawBody: 'raw3' }));
    expect(await inboxGetD1(id1)).toMatchObject({
      payload: { n: 2 },
      status: 'processed',
      result_order_id: 'o1',
      result_status: 'paid',
    });
    expect(db.prepare('SELECT COUNT(*) n FROM webhook_events').get()).toEqual({ n: 1 });
    expect(
      (db.prepare('SELECT processed_at p FROM webhook_events').get() as { p: number }).p
    ).toBeGreaterThan(0);
  });

  it('update: increment, status, last error, requeue; stuck lists wedged rows oldest first; list pages with a total', async () => {
    const db = world('inbox');
    const a = await inboxRecordD1(rec('a'));
    const b = await inboxRecordD1(rec('b'));
    expect(
      await inboxUpdateD1(a, { status: 'processing', incrementAttempts: true, lastError: 'boom' })
    ).toBe(true);
    expect(await inboxGetD1(a)).toMatchObject({
      status: 'processing',
      attempts: 1,
      last_error: 'boom',
    });
    expect(await inboxUpdateD1('nope', { status: 'x' })).toBe(false);
    db.prepare('UPDATE webhook_events SET received_at = ? WHERE id = ?').run(
      Date.now() - 3_600_000,
      a
    );
    expect((await inboxStuckD1(new Date(Date.now() - 600_000), 10)).map(r => r.id)).toEqual([a]);
    await inboxUpdateD1(a, { requeue: true });
    expect(await inboxGetD1(a)).toMatchObject({
      status: 'received',
      attempts: 0,
      last_error: null,
    });
    const page = await inboxListD1({ limit: 1, offset: 0 });
    expect(page).toHaveLength(1);
    expect(page[0].total).toBe(2);
    expect((await inboxListD1({ provider: 'nobody', limit: 10, offset: 0 })).length).toBe(0);
    void b;
  });

  it('a provider callback during the freeze is recorded into D1 (never refused) and that row can be updated', async () => {
    const db = world(null); // marker absent: the family is still on Postgres
    freeze(db, 'inbox');
    const id = await webhookInbox.record({
      provider: 'paymob',
      idempotencyKey: 'frozen-1',
      storeId: A,
      payload: { x: 1 },
      rawBody: 'r',
      signature: 's',
    });
    expect(db.prepare('SELECT idempotency_key k FROM webhook_events WHERE id = ?').get(id)).toEqual(
      { k: 'frozen-1' }
    );
    expect(await webhookInbox.update(id, { status: 'processing', incrementAttempts: true })).toBe(
      true
    );
    // an update to a row that is NOT freeze-born (it lives in Postgres being copied) is refused, retryable
    await expect(
      webhookInbox.update('some-postgres-row', { status: 'processing' })
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('freeze-window inbox callbacks are deduped against Postgres', () => {
  it('an event Postgres already holds returns ITS id and creates no D1 row; an unknown one is recorded in D1', async () => {
    const db = world(null);
    freeze(db, 'inbox');
    pg.rows = [{ id: 'pg-row-1' }];
    const known = await webhookInbox.record({
      provider: 'paymob',
      idempotencyKey: 'known',
      storeId: A,
      payload: {},
      rawBody: 'r',
      signature: 's',
    });
    expect(known).toBe('pg-row-1');
    expect(db.prepare('SELECT COUNT(*) n FROM webhook_events').get()).toEqual({ n: 0 });
    pg.rows = [];
    const fresh = await webhookInbox.record({
      provider: 'paymob',
      idempotencyKey: 'new',
      storeId: A,
      payload: {},
      rawBody: 'r',
      signature: 's',
    });
    expect(
      db.prepare('SELECT idempotency_key k FROM webhook_events WHERE id = ?').get(fresh)
    ).toEqual({ k: 'new' });
  });

  it('put-back merge: PROCESSED wins on a key the copy already holds, and never the other way round', async () => {
    const { ASIDE } = await import('../../scripts/cf/cutover-platform-family.mjs');
    const db = world('inbox');
    const lit = (v: unknown) =>
      v === null
        ? 'NULL'
        : typeof v === 'number'
          ? String(v)
          : `'${String(v).replace(/'/g, "''")}'`;
    const row = (over: Record<string, unknown>) => ({
      id: crypto.randomUUID(),
      provider: 'p',
      idempotency_key: 'k',
      store_id: null,
      payload: '{}',
      raw_body: 'r',
      signature: 's',
      status: 'received',
      attempts: 0,
      last_error: null,
      result_order_id: null,
      result_status: null,
      received_at: 9,
      processed_at: null,
      created_at: 9,
      updated_at: 9,
      ...over,
    });
    const restore = (r: Record<string, unknown>) => db.exec(ASIDE.webhook_events.restore(r, lit));
    restore(row({ id: 'pg-copy' })); // what the copy wrote: received
    restore(
      row({
        id: 'd1-born',
        status: 'processed',
        attempts: 1,
        result_order_id: 'o1',
        result_status: 'paid',
        processed_at: 10,
      })
    );
    expect(db.prepare('SELECT COUNT(*) n FROM webhook_events').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT id, status, result_order_id r FROM webhook_events').get()).toEqual({
      id: 'pg-copy',
      status: 'processed',
      r: 'o1',
    });
    restore(row({ id: 'again', status: 'received' })); // a received duplicate must not reset it
    expect(db.prepare('SELECT status FROM webhook_events').get()).toEqual({ status: 'processed' });
    restore(row({ id: 'fresh', idempotency_key: 'other' })); // unknown key: inserted as is
    expect(db.prepare('SELECT COUNT(*) n FROM webhook_events').get()).toEqual({ n: 2 });
  });

  // The inbox-miss throw of the payment consumer is proved by running the job: tests/unit/payment-webhook-inbox-miss-throws.test.ts
});

describe('platform VAT setting guard (Ruling TAX-8) on D1', () => {
  it('only a super_admin may write ebda.vat; other keys do not consult the guard', async () => {
    const db = world('platform');
    const spy = vi.spyOn(vatGuard, 'isSuperAdmin');
    spy.mockResolvedValue(false);
    await expect(
      prisma.systemSetting.upsert({
        where: { key: 'ebda.vat' },
        create: { key: 'ebda.vat', value: { enabled: true } },
        update: { value: { enabled: true } },
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'PLATFORM_VAT_FORBIDDEN' });
    expect(
      db.prepare(`SELECT COUNT(*) n FROM system_settings WHERE key = 'ebda.vat'`).get()
    ).toEqual({ n: 0 });
    spy.mockClear();
    await prisma.systemSetting.create({ data: { key: 'some.other', value: {} } });
    expect(spy).not.toHaveBeenCalled();
    // a bulk write with no literal key filter could hit ebda.vat: guarded
    await expect(
      prisma.systemSetting.deleteMany({ where: { category: 'billing' } })
    ).rejects.toMatchObject({ statusCode: 403 });
    spy.mockResolvedValue(true);
    await prisma.systemSetting.upsert({
      where: { key: 'ebda.vat' },
      create: { key: 'ebda.vat', value: { enabled: true } },
      update: { value: { enabled: false } },
    });
    expect(
      db.prepare(`SELECT COUNT(*) n FROM system_settings WHERE key = 'ebda.vat'`).get()
    ).toEqual({ n: 1 });
    spy.mockRestore();
  });
});
