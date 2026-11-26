// PR R2 (Ruling CF-R2-1): fiscal documents and counters on the StoreDO. The numbering is GAPLESS: the counter bump and the
// document are written in the section of the order, so a section that fails burns no number.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import {
  cancelSaleDocument,
  issueRefundDocument,
  issueSaleDocument,
  settleFiscalOnReversal,
} from '../src/do/fiscal';
import { MoneyError } from '../src/do/sync-sql';
import { codMarkPaidOp } from '../src/do/job-ops-b';

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(
    `INSERT INTO store_profile (store_id, name, slug, owner_id, address, phone, email) VALUES ('s1', 'Shop', 'shop', 'o1', '1 Nile St', '+201000', 'a@b.c');
     INSERT INTO products (id, store_id, name, name_ar, slug, price, inventory, status) VALUES ('sku', 's1', 'Widget', 'ودجت', 'widget', 1000, 100, 'active');`
  );
  let seq = 0;
  /** an order written by SQL: one item line, VAT-exclusive 14% unless `trn` is set it is a plain receipt. */
  const order = (o: { trn?: string; total?: number; paid?: boolean } = {}) => {
    const id = `o${++seq}`;
    const vat = 140;
    const total = o.total ?? 1140;
    raw
      .prepare(
        `INSERT INTO orders (id, store_id, order_number, status, payment_status, subtotal, tax, tax_included_in_price, tax_rate_bps, taxable_amount, seller_tax_registration_number, seller_tax_legal_name, shipping, discount, cod_fee, total, currency, shipping_address, billing_address)
         VALUES (?, 's1', ?, 'pending', ?, 1000, ?, 0, 1400, 1000, ?, ?, 0, 0, 0, ?, 'EGP', ?, ?)`
      )
      .run(
        id,
        `ORD-${seq}`,
        o.paid ? 'paid' : 'unpaid',
        vat,
        o.trn ?? null,
        o.trn ? 'Shop LLC' : null,
        total,
        JSON.stringify({
          firstName: 'Mona',
          lastName: 'Adel',
          address1: 'Nasr City',
          country: 'Egypt',
        }),
        JSON.stringify({ firstName: 'Mona', lastName: 'Adel' })
      );
    raw
      .prepare(
        `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total) VALUES (?, ?, 'sku', 'Widget', 1, 1000, 1000)`
      )
      .run(`i${seq}`, id);
    return id;
  };
  const issue = (orderId: string) =>
    db.transactionSync(() => issueSaleDocument(db, { storeId: 's1', orderId, now: 1_000 }));
  const docs = () =>
    raw
      .prepare(
        'SELECT doc_type, number, serial, status, total_amount, vat_amount, order_id FROM fiscal_documents ORDER BY doc_type, serial'
      )
      .all() as Array<Record<string, any>>;
  const counter = (t: string) =>
    (
      raw
        .prepare('SELECT last_serial n FROM fiscal_document_counters WHERE doc_type = ?')
        .get(t) as any
    )?.n ?? 0;
  return { raw, db, order, issue, docs, counter };
}

describe('sale documents', () => {
  it('a plain order gets a receipt, a verified seller TRN a tax invoice; the payload names the buyer only on the invoice', () => {
    const r = rig();
    const rcpt = r.issue(r.order());
    const inv = r.issue(r.order({ trn: '123456789' }));
    expect(rcpt).toMatchObject({ docType: 'receipt', number: 'RCT-000001' });
    expect(inv).toMatchObject({ docType: 'tax_invoice', number: 'INV-000001' });
    const payload = (n: string) =>
      JSON.parse(
        (r.raw.prepare('SELECT payload FROM fiscal_documents WHERE number = ?').get(n) as any)
          .payload
      );
    expect(payload('RCT-000001').buyer).toEqual({ name: '', addressAr: [], addressEn: [] });
    expect(payload('INV-000001').buyer).toMatchObject({
      name: 'Mona Adel',
      addressEn: ['Nasr City', 'Egypt'],
    });
    expect(payload('INV-000001').lines[0]).toMatchObject({
      description: 'Widget',
      descriptionAr: 'ودجت',
      amount: 1000,
    });
    expect(payload('INV-000001').seller).toMatchObject({
      name: 'Shop',
      trn: '123456789',
      address: '1 Nile St',
    });
  });

  it('is idempotent per order: the second call returns the first document and burns no number', () => {
    const r = rig();
    const id = r.order();
    const a = r.issue(id);
    expect(r.issue(id)).toEqual(a);
    expect(r.counter('receipt')).toBe(1);
  });

  it('an unbalanced invoice is never issued and the failed section burns no number (gapless)', () => {
    const r = rig();
    r.issue(r.order()); // RCT-000001
    const bad = r.order({ total: 9999 });
    expect(() => r.issue(bad)).toThrowError(MoneyError);
    expect(r.counter('receipt')).toBe(1);
    expect(r.issue(r.order()).number).toBe('RCT-000002');
    expect(r.docs().map(d => d.serial)).toEqual([1, 2]);
  });

  it('a refused createOrder leaves no document and no number', () => {
    const r = rig();
    const err = (() => {
      try {
        runMoneyOp(r.db, 's1', 'createOrder', {
          lines: [{ productId: 'sku', quantity: 1000 }],
          shippingAddress: { name: 'A' },
        });
      } catch (e) {
        return e as MoneyError;
      }
    })();
    expect(err).toBeInstanceOf(MoneyError);
    expect(r.docs()).toEqual([]);
    expect(r.counter('receipt')).toBe(0);
  });

  it('createOrder issues the sale document in its own section, one number per order, in order', () => {
    const r = rig();
    const place = () =>
      runMoneyOp(r.db, 's1', 'createOrder', {
        lines: [{ productId: 'sku', quantity: 1 }],
        shippingAddress: { name: 'A' },
      }) as any;
    const a = place();
    const b = place();
    const rows = r.docs();
    expect(rows.map(d => [d.number, d.order_id])).toEqual([
      ['RCT-000001', a.orderId],
      ['RCT-000002', b.orderId],
    ]);
  });
});

describe('cancel and credit notes', () => {
  it('an order that took no money keeps its number, marked cancelled; a replay is a no-op', () => {
    const r = rig();
    const id = r.order();
    r.issue(id);
    const now = 2_000;
    r.db.transactionSync(() => settleFiscalOnReversal(r.db, { storeId: 's1', orderId: id, now }));
    r.db.transactionSync(() => settleFiscalOnReversal(r.db, { storeId: 's1', orderId: id, now }));
    expect(r.docs()).toMatchObject([{ number: 'RCT-000001', status: 'cancelled' }]);
    expect(cancelSaleDocument(r.db, { storeId: 's1', orderId: id, now })).toBeNull();
  });

  it('a paid order gets one refund receipt (credit note on an invoice) for what is left, keyed per order', () => {
    const r = rig();
    const id = r.order({ trn: '123456789', paid: true });
    r.issue(id);
    for (let i = 0; i < 2; i++)
      r.db.transactionSync(() =>
        settleFiscalOnReversal(r.db, { storeId: 's1', orderId: id, now: 3_000 })
      );
    expect(r.docs().map(d => [d.doc_type, d.number, d.total_amount, d.vat_amount])).toEqual([
      ['credit_note', 'CRN-000001', 1140, 140],
      ['tax_invoice', 'INV-000001', 1140, 140],
    ]);
  });

  it('partial refunds each get a note keyed on their refund, are capped at what is un-credited, and sum to the invoice', () => {
    const r = rig();
    const id = r.order({ trn: '123456789', paid: true });
    r.issue(id);
    const refund = (ref: string, amount: number | 'remaining') =>
      r.db.transactionSync(() =>
        issueRefundDocument(r.db, {
          storeId: 's1',
          orderId: id,
          refundRef: ref,
          amount,
          now: 4_000,
        })
      );
    expect(refund('refund:a', 500)).toMatchObject({ number: 'CRN-000001' });
    expect(refund('refund:a', 500)).toMatchObject({ number: 'CRN-000001' }); // the same refund never gets two
    expect(refund('refund:b', 'remaining')).toMatchObject({ number: 'CRN-000002' });
    expect(refund('refund:c', 100)).toBeNull(); // nothing left to credit
    const credits = r.docs().filter(d => d.doc_type === 'credit_note');
    expect(credits.reduce((n, d) => n + d.total_amount, 0)).toBe(1140);
    expect(credits.reduce((n, d) => n + d.vat_amount, 0)).toBe(140);
    expect(r.counter('credit_note')).toBe(2);
  });
});

describe('COD-RECEIPT-NUMBER-AT-PAYMENT-1: the receipt number exists only once the cash is in', () => {
  const cod = (r: ReturnType<typeof rig>, orderId: string) =>
    r.raw
      .prepare(
        `INSERT INTO payments (id, order_id, provider, method, status, amount, currency, created_at, updated_at) VALUES (?, ?, 'cod', 'cod', 'cod_pending', 1140, 'EGP', 1, 1)`
      )
      .run(`pay-${orderId}`, orderId);

  it('an unpaid COD order gets NO receipt and burns no serial', () => {
    const r = rig();
    const o = r.order();
    cod(r, o);
    expect(r.issue(o)).toBeNull();
    expect(r.docs()).toHaveLength(0);
    expect(r.counter('receipt')).toBe(0);
  });

  it('marking it paid allocates the next gapless RCT serial (once, idempotent); an unpaid sibling leaves no gap', () => {
    const r = rig();
    const a = r.order();
    const b = r.order();
    cod(r, a);
    cod(r, b);
    expect(r.issue(a)).toBeNull();
    expect(r.issue(b)).toBeNull();
    // b is collected first: it takes RCT-000001, a later takes RCT-000002 (no number was reserved at placement)
    r.db.transactionSync(() => codMarkPaidOp(r.db, 's1', { orderIds: [b] }));
    r.db.transactionSync(() => codMarkPaidOp(r.db, 's1', { orderIds: [a] }));
    r.db.transactionSync(() => codMarkPaidOp(r.db, 's1', { orderIds: [a] })); // replay
    expect(r.docs().map(d => [d.order_id, d.number])).toEqual([
      [b, 'RCT-000001'],
      [a, 'RCT-000002'],
    ]);
  });

  it('placement passes cod: a COD order whose payment row does not exist yet is deferred too', () => {
    const r = rig();
    const o = r.order();
    expect(
      r.db.transactionSync(() =>
        issueSaleDocument(r.db, { storeId: 's1', orderId: o, now: 1, cod: true })
      )
    ).toBeNull();
    expect(r.docs()).toHaveLength(0);
    // a non-COD placement (no flag, no payment row) still issues at once
    expect(r.issue(r.order())).toMatchObject({ number: 'RCT-000001' });
  });

  it('a cancelled unpaid COD order never had a number to cancel', () => {
    const r = rig();
    const o = r.order();
    cod(r, o);
    r.issue(o);
    r.db.transactionSync(() => settleFiscalOnReversal(r.db, { storeId: 's1', orderId: o, now: 5 }));
    expect(r.docs()).toHaveLength(0);
  });

  it('a COD tax invoice (verified VAT seller) still issues at placement: it is a tax document, not proof of payment', () => {
    const r = rig();
    const o = r.order({ trn: '123456789' });
    cod(r, o);
    expect(r.issue(o)).toMatchObject({ docType: 'tax_invoice', number: 'INV-000001' });
  });

  it('a paid order or a non-COD order is unaffected', () => {
    const r = rig();
    const o = r.order({ paid: true });
    cod(r, o);
    expect(r.issue(o)).toMatchObject({ number: 'RCT-000001' });
  });
});
