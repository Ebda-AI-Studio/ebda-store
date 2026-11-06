// Entity index: the DO outbox -> D1 write-through, retries, write-once per id, and webhook routing.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { createPayment, indexEntity } from '../src/do/payments';
import { placeOrder } from '../src/do/checkout';
import {
  MAX_ATTEMPTS,
  ABANDON_ATTEMPTS,
  deadLetterReport,
  nextOutboxAttempt,
  awaitEntityIndexed,
  createPaymentIndexed,
  webhookHttpResponse,
  backoffMs,
  drainEntityIndexOutbox,
  resolveStoreId,
  routePaymentWebhook,
  type D1Like,
} from '../src/platform/entity-index';

function d1(opts: { failFirst?: number } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(
    fs.readFileSync(
      new URL('../../cf-schema/migrations/platform/0001_init.sql', import.meta.url),
      'utf8'
    )
  );
  let fails = opts.failFirst ?? 0;
  const like: D1Like = {
    prepare: sql => ({
      bind: (...v) => ({
        run: async () => {
          if (fails-- > 0) throw new Error('D1 unavailable');
          return { meta: { changes: Number(raw.prepare(sql).run(...(v as never[])).changes) } };
        },
        first: async <T>() => (raw.prepare(sql).get(...(v as never[])) as T) ?? null,
      }),
    }),
  };
  return { raw, like };
}
function store() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'W', 'w', 1000, 10, 'active')`
  );
  const o = placeOrder(db, {
    storeId: 's1',
    lines: [{ productId: 'sku', quantity: 1 }],
    shippingAddress: {},
  });
  createPayment(db, {
    storeId: 's1',
    orderId: o.orderId,
    provider: 'paymob',
    amount: o.total,
    transactionId: 'T1',
  });
  return { raw, db, o };
}

describe('entity index', () => {
  it('the outbox row is written with the entity and drained to D1; a webhook reference then routes to its store', async () => {
    const s = store();
    const d = d1();
    expect(await routePaymentWebhook(d.like, 'paymob', 'T1')).toEqual({
      retry: true,
      reason: 'unresolved_reference',
    }); // not drained yet: the gateway must RETRY (non-2xx), never be told "ignored"
    const r = await drainEntityIndexOutbox(s.db, d.like);
    expect(r).toMatchObject({ written: 3, failed: 0, conflicts: [] });
    expect(await routePaymentWebhook(d.like, 'paymob', 'T1')).toEqual({ storeId: 's1' });
    expect(await routePaymentWebhook(d.like, 'paymob', 'nope')).toEqual({
      retry: true,
      reason: 'unresolved_reference',
    });
    expect(await routePaymentWebhook(d.like, 'kashier', 'T1')).toEqual({
      retry: true,
      reason: 'unresolved_reference',
    }); // provider is part of the key
    // a second drain has nothing to do
    expect(await drainEntityIndexOutbox(s.db, d.like)).toMatchObject({ written: 0 });
  });

  it('a D1 outage retries with backoff and nothing is lost; the retry after a lost acknowledgement is harmless', async () => {
    const s = store();
    const d = d1({ failFirst: 3 });
    const NOW = Date.now() + 1000;
    expect(await drainEntityIndexOutbox(s.db, d.like, { now: NOW })).toMatchObject({
      written: 0,
      failed: 3,
    });
    expect(await drainEntityIndexOutbox(s.db, d.like, { now: NOW + 1 })).toMatchObject({
      written: 0,
      failed: 0,
    }); // backoff not due
    expect(
      await drainEntityIndexOutbox(s.db, d.like, { now: NOW + backoffMs(1) + 1 })
    ).toMatchObject({ written: 3, failed: 0 });
    expect(
      await resolveStoreId(
        d.like,
        'payment',
        (s.raw.prepare('SELECT id FROM payments').get() as { id: string }).id
      )
    ).toBe('s1');
    indexEntity(
      s.db,
      's1',
      'payment',
      (s.raw.prepare('SELECT id FROM payments').get() as { id: string }).id,
      NOW
    ); // duplicate queue row
    expect(await drainEntityIndexOutbox(s.db, d.like, { now: NOW + 10 * 3600_000 })).toMatchObject({
      written: 1,
      conflicts: [],
    });
  });

  it('an id is write-once: another store cannot re-point it (reported as a conflict, not applied)', async () => {
    const s = store();
    const d = d1();
    await drainEntityIndexOutbox(s.db, d.like);
    indexEntity(s.db, 'evil-store', 'webhook', 'paymob:T1', 1);
    const r = await drainEntityIndexOutbox(s.db, d.like, { now: Date.now() + 1000 });
    expect(r.conflicts).toEqual([
      { kind: 'webhook', id: 'paymob:T1', existing: 's1', attempted: 'evil-store' },
    ]);
    expect(await routePaymentWebhook(d.like, 'paymob', 'T1')).toEqual({ storeId: 's1' });
  });

  it('hostile ids and kinds resolve to nothing', async () => {
    const d = d1();
    expect(await resolveStoreId(d.like, 'order', '')).toBeNull();
    expect(await resolveStoreId(d.like, 'order', 'x'.repeat(400))).toBeNull();
    expect(await resolveStoreId(d.like, "x'; DROP TABLE entity_index;--" as never, 'a')).toBeNull();
  });

  it('a row that keeps failing is dead-lettered after MAX_ATTEMPTS: reported once, no longer retried', async () => {
    const s = store();
    const d = d1({ failFirst: 10_000 });
    let now = Date.now() + 1000;
    let dead = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      const r = await drainEntityIndexOutbox(s.db, d.like, { now });
      dead += r.deadLettered;
      now += 2 * 3600_000;
    }
    expect(dead).toBe(3); // all three queued rows (order, payment, webhook ref) hit the cap exactly once
    expect(await drainEntityIndexOutbox(s.db, d.like, { now })).toMatchObject({
      written: 0,
      failed: 0,
    });
  });

  it('NEW-3 (Ruling NZ-MONEY-2): a FORCED drain neither counts nor reschedules a failure, revives a dead-lettered row, and the alarm (includeDead) keeps retrying it', async () => {
    const s = store();
    const down = d1({ failFirst: 10_000 });
    const ids = ['T1'].map(r => `paymob:${r}`);
    const attempts = () =>
      s.raw
        .prepare("SELECT attempts AS a FROM d1_outbox WHERE json_extract(payload, '$.id') = ?")
        .get(ids[0]) as { a: number };
    for (let i = 0; i < 40; i++) {
      const r = await drainEntityIndexOutbox(s.db, down.like, { onlyIds: ids });
      expect(r.failed).toBe(1);
    }
    expect(attempts().a).toBe(0); // 40 shopper retries during the outage: not one counted
    // dead-letter it the paced way, then a forced drain on a healthy D1 still writes it (revived on demand)
    s.raw
      .prepare("UPDATE d1_outbox SET attempts = ? WHERE json_extract(payload, '$.id') = ?")
      .run(MAX_ATTEMPTS, ids[0]);
    const up = d1();
    expect((await drainEntityIndexOutbox(s.db, up.like, { onlyIds: ids })).written).toBe(1);
    expect(await resolveStoreId(up.like, 'webhook', ids[0]!)).toBe('s1');
    // the alarm path: a dead-lettered row that is due is retried with includeDead, skipped without it
    const s2 = store();
    s2.raw.prepare('UPDATE d1_outbox SET attempts = ?').run(MAX_ATTEMPTS);
    const later = Date.now() + 10 * 3600_000;
    expect((await drainEntityIndexOutbox(s2.db, up.like, { now: later })).written).toBe(0);
    expect(
      (await drainEntityIndexOutbox(s2.db, up.like, { now: later, includeDead: true })).written
    ).toBe(3);
  });

  it('a paced drain reports a row crossing the dead-letter limit once (newlyDead)', async () => {
    const s = store();
    const d = d1({ failFirst: 10_000 });
    let now = Date.now() + 1000;
    let newly = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      newly += (await drainEntityIndexOutbox(s.db, d.like, { now, includeDead: true })).newlyDead;
      now += 2 * 3600_000;
    }
    expect(newly).toBe(3);
  });

  it('issue 458: a dead row is retried hourly up to ABANDON_ATTEMPTS, then abandoned once - no more wakes, no more retries', async () => {
    const s = store();
    const d = d1({ failFirst: 100_000 });
    let now = Date.now() + 1000;
    let abandoned = 0;
    for (let i = 0; i < ABANDON_ATTEMPTS + 10; i++) {
      abandoned += (await drainEntityIndexOutbox(s.db, d.like, { now, includeDead: true }))
        .newlyAbandoned;
      now += 2 * 3600_000;
    }
    expect(abandoned).toBe(3); // the three queued rows, each exactly once
    // abandoned rows no longer wake the DO and no longer retry
    expect(nextOutboxAttempt(s.db)).toBeNull();
    expect(await drainEntityIndexOutbox(s.db, d.like, { now, includeDead: true })).toMatchObject({
      written: 0,
      failed: 0,
    });
    expect(deadLetterReport(s.db)).toMatchObject({ dead: 3, abandoned: 3 });
    // ...but a forced drain still writes one on demand (a payment about to be handed out is never refused for it)
    const up = d1();
    expect((await drainEntityIndexOutbox(s.db, up.like, { onlyIds: ['paymob:T1'] })).written).toBe(
      1
    );
  });

  it('issue 458: a malformed payload can never be written - abandoned at once, alerted once', async () => {
    const s = store();
    s.raw.exec('DELETE FROM d1_outbox; ');
    s.raw
      .prepare(
        "INSERT INTO d1_outbox (kind, payload, attempts, next_attempt_at) VALUES ('entity_index', ?, 0, 0)"
      )
      .run(JSON.stringify({ kind: 'nonsense', id: 'x', storeId: 's1' }));
    const d = d1();
    const first = await drainEntityIndexOutbox(s.db, d.like, { now: Date.now() });
    expect(first).toMatchObject({ failed: 1, newlyAbandoned: 1 });
    const again = await drainEntityIndexOutbox(s.db, d.like, {
      now: Date.now() + 9e9,
      includeDead: true,
    });
    expect(again).toMatchObject({ failed: 0, newlyAbandoned: 0 });
    expect(nextOutboxAttempt(s.db)).toBeNull();
  });

  it('issue 458: deadLetterReport lists only rows at or past the dead-letter limit', async () => {
    const s = store();
    expect(deadLetterReport(s.db)).toEqual({ dead: 0, abandoned: 0, rows: [] });
    s.raw
      .prepare('UPDATE d1_outbox SET attempts = ? WHERE id = (SELECT MIN(id) FROM d1_outbox)')
      .run(MAX_ATTEMPTS);
    const r = deadLetterReport(s.db);
    expect(r).toMatchObject({ dead: 1, abandoned: 0 });
    expect(r.rows[0]).toMatchObject({ storeId: 's1', attempts: MAX_ATTEMPTS, abandoned: false });
  });

  it('DB-2: a callback that arrives BEFORE the alarm drains the outbox is answered non-2xx (retry) and alerted, never "ignored"; after the drain it routes', async () => {
    const s = store(); // payment created, outbox row queued, alarm has NOT run
    const d = d1();
    const route = await routePaymentWebhook(d.like, 'paymob', 'T1');
    expect(route).toEqual({ retry: true, reason: 'unresolved_reference' });
    const http = webhookHttpResponse(
      route as { retry: true; reason: 'unresolved_reference' },
      'paymob'
    );
    expect(http.status).toBe(503); // non-2xx: the gateway retries
    expect(http.headers['Retry-After']).toBe('30');
    expect(http.alert.kind).toBe('webhook_unresolved_reference');
    expect(JSON.stringify(http.body)).not.toContain('s1'); // no store existence oracle
    await drainEntityIndexOutbox(s.db, d.like); // the alarm runs
    expect(await routePaymentWebhook(d.like, 'paymob', 'T1')).toEqual({ storeId: 's1' }); // the gateway's retry succeeds
  });

  it('DB-2: createPaymentIndexed makes the payment routable BEFORE it returns (no alarm needed); the reference is never handed out if D1 cannot take it', async () => {
    const raw = openSqlite();
    const db = nodeSyncSql(raw);
    raw.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'W', 'w', 1000, 10, 'active')`
    );
    const o = placeOrder(db, {
      storeId: 's1',
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: {},
    });
    // the order itself was queued in the same section as its creation
    expect(
      raw.prepare(`SELECT count(*) n FROM d1_outbox WHERE payload LIKE '%"kind":"order"%'`).get()
    ).toEqual({ n: 1 });
    const up = d1();
    const { paymentId } = await createPaymentIndexed(db, up.like, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'TX-9',
    });
    expect(await routePaymentWebhook(up.like, 'paymob', 'TX-9')).toEqual({ storeId: 's1' });
    expect(await resolveStoreId(up.like, 'payment', paymentId)).toBe('s1');
    // D1 down: the call fails 503 and the caller must not return the reference
    const raw2 = openSqlite();
    const db2 = nodeSyncSql(raw2);
    raw2.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'W', 'w', 1000, 10, 'active')`
    );
    const o2 = placeOrder(db2, {
      storeId: 's1',
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: {},
    });
    const down = d1({ failFirst: 1000 });
    await expect(
      createPaymentIndexed(db2, down.like, {
        storeId: 's1',
        orderId: o2.orderId,
        provider: 'paymob',
        amount: o2.total,
        transactionId: 'TX-8',
      })
    ).rejects.toMatchObject({ code: 'ENTITY_INDEX_UNAVAILABLE', status: 503 });
    // the rows stay queued: the alarm retries them
    expect(
      raw2.prepare(`SELECT count(*) n FROM d1_outbox WHERE done_at IS NULL`).get().n
    ).toBeGreaterThan(0);
  });

  it('awaitEntityIndexed verifies the SPECIFIC ids (an unrelated queued row that keeps failing does not block, a missing one does)', async () => {
    const s = store();
    const d = d1();
    await awaitEntityIndexed(s.db, d.like, 's1', [
      { kind: 'order', id: (s.raw.prepare('SELECT id FROM orders').get() as { id: string }).id },
    ]);
    // an id nobody queued and D1 does not have is NOT "indexed": fail closed
    await expect(
      awaitEntityIndexed(s.db, d.like, 's1', [{ kind: 'webhook', id: 'paymob:NEVER' }])
    ).rejects.toMatchObject({ code: 'ENTITY_INDEX_UNAVAILABLE' });
  });

  it('SECURITY: an id already owned by ANOTHER store is a conflict - the payment reference is never handed out (no wrong-tenant routing)', async () => {
    const raw = openSqlite();
    const db = nodeSyncSql(raw);
    raw.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'W', 'w', 1000, 10, 'active')`
    );
    const o = placeOrder(db, {
      storeId: 's1',
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: {},
    });
    const d = d1();
    // store 'victim' already owns the provider reference (webhook paymob:TX-X) in D1
    await d.like
      .prepare('INSERT INTO entity_index (kind, id, store_id) VALUES (?, ?, ?)')
      .bind('webhook', 'paymob:TX-X', 'victim')
      .run();
    await expect(
      createPaymentIndexed(db, d.like, {
        storeId: 's1',
        orderId: o.orderId,
        provider: 'paymob',
        amount: o.total,
        transactionId: 'TX-X',
      })
    ).rejects.toMatchObject({ code: 'ENTITY_INDEX_CONFLICT' });
    // the reference still routes to its real owner only
    expect(await routePaymentWebhook(d.like, 'paymob', 'TX-X')).toEqual({ storeId: 'victim' });
    // a SECOND attempt (the conflict row is already marked done) is still refused: D1 is re-read, not trusted from "not pending"
    await expect(
      awaitEntityIndexed(db, d.like, 's1', [{ kind: 'webhook', id: 'paymob:TX-X' }])
    ).rejects.toMatchObject({ code: 'ENTITY_INDEX_CONFLICT' });
  });
});
