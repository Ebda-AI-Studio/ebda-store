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
      noop: true,
      reason: 'unknown_reference',
    }); // not drained yet
    const r = await drainEntityIndexOutbox(s.db, d.like);
    expect(r).toMatchObject({ written: 2, failed: 0, conflicts: [] });
    expect(await routePaymentWebhook(d.like, 'paymob', 'T1')).toEqual({ storeId: 's1' });
    expect(await routePaymentWebhook(d.like, 'paymob', 'nope')).toEqual({
      noop: true,
      reason: 'unknown_reference',
    });
    expect(await routePaymentWebhook(d.like, 'kashier', 'T1')).toEqual({
      noop: true,
      reason: 'unknown_reference',
    }); // provider is part of the key
    // a second drain has nothing to do
    expect(await drainEntityIndexOutbox(s.db, d.like)).toMatchObject({ written: 0 });
  });

  it('a D1 outage retries with backoff and nothing is lost; the retry after a lost acknowledgement is harmless', async () => {
    const s = store();
    const d = d1({ failFirst: 2 });
    const NOW = Date.now() + 1000;
    expect(await drainEntityIndexOutbox(s.db, d.like, { now: NOW })).toMatchObject({
      written: 0,
      failed: 2,
    });
    expect(await drainEntityIndexOutbox(s.db, d.like, { now: NOW + 1 })).toMatchObject({
      written: 0,
      failed: 0,
    }); // backoff not due
    expect(
      await drainEntityIndexOutbox(s.db, d.like, { now: NOW + backoffMs(1) + 1 })
    ).toMatchObject({ written: 2, failed: 0 });
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
    expect(dead).toBe(2); // both queued rows hit the cap exactly once
    expect(await drainEntityIndexOutbox(s.db, d.like, { now })).toMatchObject({
      written: 0,
      failed: 0,
    });
  });
});
