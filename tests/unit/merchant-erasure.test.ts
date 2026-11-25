/**
 * Rulings NZ-D16 / NZ-D17 / RETENTION-1 / RETENTION-2: PDPL merchant erasure ANONYMISES and keeps the legal records; the money gate
 * and the anonymisation are ONE atomic step; no code path wipes a Durable Object. Real StoreDO schema on node:sqlite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { INSTAPAY_RECEIPT_DDL } from '../../packages/repo/src/do/instapay-receipts';
import { ERASURE_LEDGER_DDL } from '../../packages/repo/src/do/erase-shopper';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { closeStore, isStoreClosed, moneyInFlightOnDo } from '../../packages/repo/src/do/closure';
import {
  eraseMerchantAtomically,
  merchantPiiPlan,
} from '../../apps/api/src/cf/erasure/merchant-anonymise';
import { runErasure } from '../../apps/api/src/cf/erasure/job';
import {
  PDPL_ERASURE_ACK_HOURS,
  PDPL_ERASURE_COMPLETE_DAYS,
  RETENTION_YEARS,
} from '../../apps/api/src/config/retention';
import type { SqlExec } from '../../apps/api/src/cf/erasure/store-do-sql';
import { stripComments } from './helpers/source-scan';

const ROOT = path.resolve(__dirname, '../..');
const dir = path.join(ROOT, 'packages/cf-schema/migrations/store');

function openDo(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort())
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const s of INSTAPAY_RECEIPT_DDL) db.exec(s);
  db.exec(ERASURE_LEDGER_DDL);
  return db;
}
const exec = (db: DatabaseSync): SqlExec => ({
  exec: (q, ...b) => {
    const rows = db.prepare(q).all(...(b as never[])) as never[];
    return { toArray: () => rows };
  },
});
const deps = (db: DatabaseSync) => {
  const sync = nodeSyncSql(db);
  return {
    sql: exec(db),
    sync,
    transactionSync: sync.transactionSync.bind(sync),
    scrubReceipts: () => undefined,
    moneyInFlight: (d: typeof sync) => moneyInFlightOnDo(d) as unknown as Record<string, number>,
    closeStore: (d: typeof sync) => closeStore(d),
  };
};
const count = (db: DatabaseSync, t: string) =>
  (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;

function seed(db: DatabaseSync, over: { orderStatus?: string } = {}) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(
    "INSERT INTO store_profile (store_id, name, slug, owner_id, email, phone, address) VALUES ('s1','Shop','shop','owner-1','o@x.com','+201','Cairo')"
  ).run();
  db.prepare(
    "INSERT INTO customers (id, store_id, email, phone, first_name, last_name) VALUES ('c1','s1','buyer@x.com','+202','Ali','B')"
  ).run();
  db.prepare(
    `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, tax, discount, shipping, total, shipping_address, billing_address, customer_notes, created_at, updated_at)
    VALUES ('o1','s1','c1','N1',?, 'paid',1000,140,0,0,1140,'{"city":"Giza"}','{"city":"Giza"}','call me',1,1)`
  ).run(over.orderStatus ?? 'delivered');
  db.prepare(
    "INSERT INTO payments (id, order_id, provider, method, status, amount, currency, created_at, updated_at) VALUES ('p1','o1','x','card','completed',1140,'EGP',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO newsletter_subscribers (id, store_id, email) VALUES ('n1','s1','buyer@x.com')"
  ).run();
  db.prepare(
    "INSERT INTO fiscal_documents (id, store_id, order_id, doc_type, serial, number, status, issued_at, currency, net_amount, vat_amount, total_amount, seller_trn, payload, retain_until) VALUES ('f1','s1','o1','tax_invoice',1,'INV-1','issued',1,'EGP',1000,140,1140,'TRN-9','{}',9999999999999)"
  ).run();
}

describe('merchant erasure anonymises and keeps the legal records', () => {
  it('buyer identity is irreversibly removed from orders; order, VAT, payment and fiscal rows stay', () => {
    const db = openDo();
    seed(db);
    const r = eraseMerchantAtomically(deps(db), 'req-12345678');
    expect(r.refused).toBeUndefined();
    expect(r.remaining).toBe(0);
    const o = db.prepare("SELECT * FROM orders WHERE id='o1'").get() as Record<string, unknown>;
    expect(o.total).toBe(1140);
    expect(o.tax).toBe(140);
    expect(o.payment_status).toBe('paid');
    expect(JSON.stringify(o)).not.toMatch(/Giza|call me|c1/);
    expect(count(db, 'payments')).toBe(1);
    const f = db.prepare("SELECT * FROM fiscal_documents WHERE id='f1'").get() as Record<
      string,
      unknown
    >;
    expect(f).toMatchObject({ seller_trn: 'TRN-9', vat_amount: 140, total_amount: 1140 });
  });
  it('account, cart, consent and marketing data are deleted now', () => {
    const db = openDo();
    seed(db);
    eraseMerchantAtomically(deps(db), 'req-12345678');
    expect(count(db, 'customers')).toBe(0);
    expect(count(db, 'newsletter_subscribers')).toBe(0);
  });
  it("the merchant's own contact details are anonymised in place (NOT NULL columns get a per-request token); the store is closed", () => {
    const db = openDo();
    seed(db);
    const d = deps(db);
    eraseMerchantAtomically(d, 'req-12345678');
    const p = db.prepare("SELECT * FROM store_profile WHERE store_id='s1'").get() as Record<
      string,
      unknown
    >;
    expect(p.email).toBeNull();
    expect(p.phone).toBeNull();
    expect(p.address).toBeNull();
    expect(p.owner_id).toBe('erased:req-1234');
    expect(isStoreClosed(d.sync)).toBe(true);
  });
  it('the plan never names a retained table', () => {
    const tables = merchantPiiPlan().map(p => p.table);
    expect(tables).not.toContain('fiscal_documents');
    expect(tables).not.toContain('eta_receipts');
    expect(tables.length).toBeGreaterThan(10);
  });
});

describe('the money gate and the anonymisation are ONE atomic step (NZ-D17)', () => {
  it('money in flight: refused, NOTHING changed, store stays open', () => {
    const db = openDo();
    seed(db, { orderStatus: 'processing' }); // paid, not delivered
    const d = deps(db);
    const r = eraseMerchantAtomically(d, 'req-12345678');
    expect(r.refused).toMatchObject({ paidUndelivered: 1 });
    expect(r.remaining).toBeGreaterThan(0);
    expect(count(db, 'customers')).toBe(1);
    expect(JSON.stringify(db.prepare("SELECT * FROM orders WHERE id='o1'").get())).toMatch(/Giza/);
    expect(isStoreClosed(d.sync)).toBe(false);
  });
  it('a failure in the middle rolls the WHOLE erasure back', () => {
    const db = openDo();
    seed(db);
    const d = deps(db);
    d.scrubReceipts = () => {
      throw new Error('boom');
    };
    expect(() => eraseMerchantAtomically(d, 'req-12345678')).toThrow('boom');
    expect(count(db, 'customers')).toBe(1);
    expect(isStoreClosed(d.sync)).toBe(false);
  });
});

describe('the erasure job gates on the StoreDO first (NZ-D17)', () => {
  it('a refusal stops the job BEFORE identity / media / CI are touched', async () => {
    const ran: string[] = [];
    const mk = (name: string, remaining = 0, note?: string) => ({
      name,
      exportSubject: async () => ({ surface: name, ndjson: '', records: 0 }),
      eraseSubject: async () => {
        ran.push(name);
        return { surface: name, erased: 0, remaining, ...(note ? { note } : {}) };
      },
    });
    const store = { put: vi.fn(async () => undefined), get: vi.fn(async () => null) };
    const entry = await runErasure(
      { PDPL_CF_ERASURE_ENABLED: 'true', STORE_BACKUPS: store } as never,
      [mk('identity'), mk('media'), mk('store-do', 3, 'refused: money in flight')] as never,
      { kind: 'merchant', requestId: 'r1', storeId: 's1', ownerUserId: 'u1' } as never
    );
    expect(ran).toEqual(['store-do']);
    expect(entry.status).toBe('failed');
    expect(entry.errors.join(' ')).toMatch(/money in flight/);
  });
});

describe('no wipe is reachable from merchant erasure; constants', () => {
  it('no deleteAll in the StoreDO, the anonymiser or the erasure surfaces (comments stripped)', () => {
    for (const f of [
      'apps/api/src/cf/store-do/store-do.ts',
      'apps/api/src/cf/erasure/merchant-anonymise.ts',
      'apps/api/src/cf/erasure/surfaces.ts',
      'apps/api/src/cf/erasure/job.ts',
    ])
      expect(stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8')), f).not.toMatch(
        /deleteAll\s*\(/
      );
  });
  it('NZ-D15B: the only physical wipe is closed-store-wipe.ts, called only by StoreDO.purgeClosedStore, never from erasure', () => {
    const wipe = 'apps/api/src/cf/store-do/closed-store-wipe.ts';
    expect(stripComments(fs.readFileSync(path.join(ROOT, wipe), 'utf8'))).toMatch(/deleteAll\s*\(/);
    for (const f of [
      'apps/api/src/cf/erasure/merchant-anonymise.ts',
      'apps/api/src/cf/erasure/surfaces.ts',
      'apps/api/src/cf/erasure/job.ts',
    ])
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(
        /closed-store-wipe|wipeClosedStoreStorage/
      );
    const doSrc = stripComments(
      fs.readFileSync(path.join(ROOT, 'apps/api/src/cf/store-do/store-do.ts'), 'utf8')
    );
    expect(doSrc.match(/wipeClosedStoreStorage\s*\(/g)).toHaveLength(1);
    expect(doSrc).toMatch(
      /purgeClosedStore[\s\S]*?isStoreClosed[\s\S]*?wipeClosedStoreStorage\s*\(/
    );
  });
  it('RETENTION-1: 7 years is the one constant the fiscal archive reads; RETENTION-2: 72 h ack, 7 days complete', () => {
    expect(RETENTION_YEARS).toBe(7);
    expect(PDPL_ERASURE_ACK_HOURS).toBe(72);
    expect(PDPL_ERASURE_COMPLETE_DAYS).toBe(7);
    const fiscal = fs.readFileSync(
      path.join(ROOT, 'apps/api/src/services/fiscal-document.service.ts'),
      'utf8'
    );
    expect(fiscal).toMatch(/FISCAL_RETENTION_YEARS = RETENTION_YEARS/);
  });
});
