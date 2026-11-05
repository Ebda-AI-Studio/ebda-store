// Security review (NZ-AN-1): erasing a shopper must delete only the notification-log rows tied to THAT shopper. A shopper who typed
// somebody else's phone on an order must not erase that person's delivery history.
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { eraseShopper } from '../src/do/erase-shopper';
import { ensureCustomerAuthSchema } from '../src/do/customer-auth';
import { ensureReceiptSchema } from '../src/do/instapay-receipts';

vi.mock('@ebda/shared', async () => await import('../../shared/src/region'));

describe('erase shopper: notification_logs', () => {
  it('deletes the shopper own-order rows, not the rows another person receives on a phone the shopper typed', () => {
    const raw = openSqlite();
    const db = nodeSyncSql(raw);
    ensureCustomerAuthSchema(db);
    ensureReceiptSchema(db);
    const HB = 'b'.repeat(64);
    const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
    const count = (sql: string, ...p: unknown[]) =>
      (raw.prepare(sql).get(...(p as never[])) as { n: number }).n;
    x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('a', 's1', 'A', 'A')`);
    // A's order carries B's phone hash (typed, never verified).
    x(
      `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, shipping_address, billing_address, buyer_key) VALUES ('oA', 's1', 'a', 'ORD-A1', 100, 100, '{}', '{}', '${HB}')`
    );
    const log = (id: string, key: string, phone: string) =>
      x(
        `INSERT INTO notification_logs (id, store_id, channel, event, recipient_phone_hash, idempotency_key) VALUES (?, 's1', 'sms', 'order_created', ?, ?)`,
        id,
        phone,
        key
      );
    log('ownRow', 'sms_s1_order_created_ORD-A1', HB); // the message about A's own order
    log('bOtherOrder', 'sms_s1_order_created_ORD-B9', HB); // B's history, another order, same phone
    log('bLater', 'sms_s1_shipped_ORD-B9', HB);
    eraseShopper(db, {
      storeId: 's1',
      userId: 'a',
      role: 'customer',
      email: null,
      phone: null,
      smsPhoneKey: null,
      provenBuyerKey: null,
      actorId: 'a',
      capWindowMs: 1000,
      now: 1_700_000_000_000,
    } as never);
    expect(count(`SELECT COUNT(*) AS n FROM notification_logs WHERE id = 'ownRow'`)).toBe(0);
    expect(
      count(`SELECT COUNT(*) AS n FROM notification_logs WHERE id IN ('bOtherOrder','bLater')`)
    ).toBe(2);
  });

  it('a buyer key PROVEN to be the shopper own (verified phone) deletes its rows too', () => {
    const raw = openSqlite();
    const db = nodeSyncSql(raw);
    ensureCustomerAuthSchema(db);
    ensureReceiptSchema(db);
    const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
    x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('a', 's1', 'A', 'A')`);
    x(
      `INSERT INTO notification_logs (id, store_id, channel, event, recipient_phone_hash, idempotency_key) VALUES ('mine', 's1', 'sms', 'promo', 'HASH-A', 'k1'), ('other', 's1', 'sms', 'promo', 'HASH-B', 'k2')`
    );
    eraseShopper(db, {
      storeId: 's1',
      userId: 'a',
      role: 'customer',
      email: null,
      phone: null,
      smsPhoneKey: null,
      provenBuyerKey: 'HASH-A',
      actorId: 'a',
      capWindowMs: 1000,
      now: 1_700_000_000_000,
    } as never);
    const ids = (raw.prepare(`SELECT id FROM notification_logs`).all() as { id: string }[]).map(
      r => r.id
    );
    expect(ids).toEqual(['other']);
  });
});
