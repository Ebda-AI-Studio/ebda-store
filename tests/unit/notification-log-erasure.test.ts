/** Ruling NZ-AN-1: the SMS log keys a recipient by the suite buyer key (not a reversible SHA-256) and a shopper erasure deletes by it. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buyerKeyFor } from '@ebda/shared';
import { recipientPhoneKey } from '@api/lib/notification-recipient';
import { eraseCustomerRows, countCustomerRows } from '@api/cf/erasure/store-do-sql';
import { STORE_DO_REGISTRY } from '@api/cf/erasure/registry';

const REG = { notification_logs: STORE_DO_REGISTRY.notification_logs };
const SECRET = 's'.repeat(40);
const PHONE = '01012345678';
const exec = (db: DatabaseSync) => ({
  exec: (q: string, ...b: unknown[]) => {
    const rows = /^\s*(SELECT|PRAGMA)/i.test(q)
      ? (db.prepare(q).all(...(b as never[])) as Array<Record<string, unknown>>)
      : (db.prepare(q).run(...(b as never[])), []);
    return { toArray: () => rows };
  },
});

beforeEach(() => {
  process.env.SUITE_BUYER_KEY_SECRET = SECRET;
});

describe('recipientPhoneKey', () => {
  it('is the buyer key of the E.164 phone, never a plain SHA-256 of it', async () => {
    const k = await recipientPhoneKey(PHONE);
    expect(k).toBe(await buyerKeyFor(SECRET, '+201012345678'));
    expect(k).not.toBe(createHash('sha256').update(PHONE).digest('hex'));
    expect(k).not.toBe(createHash('sha256').update('+201012345678').digest('hex'));
  });
  it('stores nothing without a secret or a usable phone', async () => {
    expect(await recipientPhoneKey('abc')).toBeNull();
    process.env.SUITE_BUYER_KEY_SECRET = '';
    expect(await recipientPhoneKey(PHONE)).toBeNull();
  });
});

describe('shopper erasure of notification_logs', () => {
  it("deletes the shopper's rows by buyer key and leaves other recipients", async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(
      fs.readFileSync(
        path.resolve(__dirname, '../../packages/cf-schema/migrations/store/0003_analytics.sql'),
        'utf8'
      )
    );
    const mine = (await recipientPhoneKey(PHONE))!;
    const other = (await recipientPhoneKey('01199999999'))!;
    const ins = db.prepare(
      "INSERT INTO notification_logs (id, store_id, channel, event, recipient_phone_hash, idempotency_key) VALUES (?, 's1', 'sms', 'e', ?, ?)"
    );
    ins.run('a', mine, 'k1');
    ins.run('b', mine, 'k2');
    ins.run('c', other, 'k3');
    const subject = { kind: 'customer', requestId: 'r', buyerKey: mine } as never;
    expect(countCustomerRows(exec(db), subject, REG)).toBe(2);
    expect(eraseCustomerRows(exec(db), subject, REG).notification_logs).toBe(2);
    expect(db.prepare('SELECT id FROM notification_logs').all()).toEqual([{ id: 'c' }]);
  });
});
