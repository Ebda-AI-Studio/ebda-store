// Customer + order lookups on the DO, and the guard that EVERY writer keeps the search index fresh (triggers + flush).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { nodeSqlRunner } from './node-sql';
import { createPrismaLite } from '../src/prisma-lite/client';
import { META } from './diff-harness';
import {
  SEARCH_STATEMENTS,
  ensureSearchIndex,
  flushSearchIndex,
  searchProductIdSet,
  verifyProductIndex,
} from '../src/do/search';
import { searchOrderIds } from '../src/do/order-search';
import { matchingCustomers, searchOrderNumbers } from '../src/do/search-customers';
import { buildCustomerPatterns, digitsOnly, normalizeArabicSearch } from '../../shared/src/search';

function fx() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureSearchIndex(db);
  let n = 0;
  const customer = (
    id: string,
    first: string,
    last: string,
    o: { phone?: string; email?: string; store?: string } = {}
  ) =>
    raw
      .prepare(
        `INSERT INTO customers (id, store_id, first_name, last_name, phone, email) VALUES (?,?,?,?,?,?)`
      )
      .run(id, o.store ?? 's1', first, last, o.phone ?? null, o.email ?? null);
  const order = (
    id: string,
    o: {
      number?: string;
      customer?: string | null;
      ship?: Record<string, string>;
      deleted?: boolean;
      store?: string;
    } = {}
  ) =>
    raw
      .prepare(
        `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, shipping_address, billing_address, deleted_at) VALUES (?,?,?,?,0,0,?,'{}',?)`
      )
      .run(
        id,
        o.store ?? 's1',
        o.customer ?? null,
        o.number ?? `N${++n}`,
        JSON.stringify(o.ship ?? {}),
        o.deleted ? 1 : null
      );
  return { raw, db, customer, order };
}

describe('customer lookup', () => {
  it('names (AND, folded), phone in any form, email (case-insensitive), registered vs guest, store scope, deleted guest orders', () => {
    const f = fx();
    f.customer('c1', 'محمد', 'أحمد', { phone: '01012345678', email: 'Mo@Shop.com' });
    f.customer('c2', 'Sara', 'Ali', { phone: '+20 111 222 3333' });
    f.customer('c3', 'محمد', 'الشريف', { store: 's2' });
    f.order('g1', {
      ship: { firstName: 'مُحَمَّد', lastName: 'علي', phone: '٠١٠٩٩٩٩٨٨٨٨', email: 'GUEST@x.com' },
    });
    f.order('g2', { ship: { firstName: 'محمد', lastName: 'سمير' }, deleted: true });
    f.order('g3', { ship: { firstName: 'Zed' }, customer: 'c1' }); // a registered customer's order is not a guest
    const m = (q: string) => matchingCustomers(f.db, 's1', q);
    expect(m('محمد')).toMatchObject({ userIds: ['c1'], guestOrderIds: ['g1'] });
    expect(m('احمد محمد').userIds).toEqual(['c1']); // both tokens, any order, hamza folded
    expect(m('محمد سمير')).toMatchObject({ userIds: [], guestOrderIds: [] }); // deleted guest order
    expect(m('+20 101 234 5678').userIds).toEqual(['c1']); // any phone form
    expect(m('01099998888').guestOrderIds).toEqual(['g1']); // Arabic-Indic digits stored
    expect(m('+201112223333').userIds).toEqual(['c2']);
    expect(m('mo@shop').userIds).toEqual(['c1']); // ILIKE
    expect(m('guest@x.com').guestOrderIds).toEqual(['g1']);
    expect(m('zed')).toMatchObject({ userIds: [], guestOrderIds: [] });
    expect(m('')).toMatchObject({ userIds: [], guestOrderIds: [] });
    expect(matchingCustomers(f.db, 's2', 'محمد').userIds).toEqual(['c3']);
    expect(matchingCustomers(f.db, 's3', 'محمد').userIds).toEqual([]);
  });

  it('caps: cap+1 detects "more"', () => {
    const f = fx();
    for (let i = 0; i < 5; i++) f.customer(`c${i}`, 'Omar', `X${i}`);
    expect(matchingCustomers(f.db, 's1', 'omar', { userCap: 3 })).toMatchObject({
      truncated: true,
      usersTruncated: true,
    });
    expect(matchingCustomers(f.db, 's1', 'omar', { userCap: 3 }).userIds).toHaveLength(3);
    expect(matchingCustomers(f.db, 's1', 'omar', { userCap: 5 }).truncated).toBe(false);
  });

  it('% _ and \\ typed by the admin are literal', () => {
    const f = fx();
    f.customer('c1', 'A_B', 'Z');
    f.customer('c2', 'AxB', 'Z');
    expect(matchingCustomers(f.db, 's1', 'a_b').userIds).toEqual(['c1']);
  });

  it('fuzz vs a plain-JS oracle (names AND, digits, email)', () => {
    let a = 11;
    const r = () => ((a = (a * 1664525 + 1013904223) | 0) >>> 0) / 4294967296;
    const AL = ['م', 'ح', 'د', 'أ', 'ا', 'ة', 'ه', 'a', 'B', 'o', ' ', '٣', '5', '_', '%'];
    const rs = (n: number) =>
      Array.from({ length: n }, () => AL[Math.floor(r() * AL.length)]).join('');
    for (let round = 0; round < 30; round++) {
      const f = fx();
      const rows = Array.from({ length: 20 }, (_, i) => ({
        id: `c${i}`,
        first: rs(4),
        last: rs(4),
        phone: r() < 0.5 ? `0${Math.floor(r() * 1e10)}` : null,
        email: r() < 0.4 ? `${rs(5).replace(/ /g, '')}@x.com` : null,
      }));
      rows.forEach((x, i) =>
        f.customer(x.id, x.first || 'q', x.last || 'q', {
          phone: x.phone ?? undefined,
          email: x.email ? `${i}${x.email}` : undefined,
        })
      );
      for (let k = 0; k < 12; k++) {
        const s = rows[Math.floor(r() * rows.length)];
        const full = `${s.first} ${s.last}`;
        const q =
          r() < 0.3 && s.phone
            ? s.phone.slice(1, 7)
            : full.slice(Math.floor(r() * 3), Math.floor(r() * 3) + 3 + Math.floor(r() * 4));
        const p = buildCustomerPatterns(q);
        const want = rows
          .filter((x, i) => {
            const name = normalizeArabicSearch(`${x.first || 'q'} ${x.last || 'q'}`);
            const lit = (pat: string) => pat.slice(1, -1).replace(/\\(.)/g, '$1');
            const nameOk = p.names.length > 0 && p.names.every(t => name.includes(lit(t)));
            const dOk = p.digits !== null && digitsOnly(x.phone).includes(p.digits.slice(1, -1));
            const eOk =
              p.email !== null &&
              x.email !== null &&
              `${i}${x.email}`.toLowerCase().includes(lit(p.email).toLowerCase());
            return nameOk || dOk || eOk;
          })
          .map(x => x.id)
          .sort();
        expect(matchingCustomers(f.db, 's1', q).userIds.slice().sort(), JSON.stringify(q)).toEqual(
          want
        );
      }
    }
  });
});

describe('registered customers and orders.customer_id (Ruling CF-FIX-1)', () => {
  it('a migrated order carries the platform users.id: the CRM row (own id, user_id link) finds it; a merchant-opened order carries customers.id', () => {
    const f = fx();
    f.customer('crm-1', 'خالد', 'منصور', { phone: '01234567890' });
    f.raw.prepare("UPDATE customers SET user_id = 'user-9' WHERE id = 'crm-1'").run();
    f.customer('crm-2', 'خالد', 'سعيد'); // no linked user: its own id is what its orders carry
    f.order('migrated', { customer: 'user-9' }); // customer_id is a users.id, NOT a customers.id
    f.order('opened', { customer: 'crm-2' });
    f.order('other', { customer: 'user-77' });
    const ids = (q: string) => searchOrderIds(f.db, 's1', q).userIds.sort();
    expect(ids('منصور')).toEqual(['crm-1', 'user-9']);
    expect(ids('01234567890')).toEqual(['crm-1', 'user-9']);
    expect(ids('سعيد')).toEqual(['crm-2']);
    expect(ids('خالد')).toEqual(['crm-1', 'crm-2', 'user-9']);
    // the order list filters `customer_id IN userIds`: it must return the migrated order and the merchant-opened one
    const hit = (q: string) =>
      (
        f.raw
          .prepare(
            'SELECT id FROM orders WHERE customer_id IN (SELECT value FROM json_each(?)) ORDER BY id'
          )
          .all(JSON.stringify(ids(q))) as Array<{ id: string }>
      ).map(r => r.id);
    expect(hit('منصور')).toEqual(['migrated']);
    expect(hit('خالد')).toEqual(['migrated', 'opened']);
  });
  it('another store’s link is never returned', () => {
    const f = fx();
    f.customer('crm-s2', 'خالد', 'منصور', { store: 's2' });
    f.raw.prepare("UPDATE customers SET user_id = 'u-s2' WHERE id = 'crm-s2'").run();
    expect(searchOrderIds(f.db, 's1', 'منصور').userIds).toEqual([]);
  });
});

describe('order number lookup', () => {
  it('contains-match, literal wildcards, live orders of this store only', () => {
    const f = fx();
    f.order('a', { number: 'EBD-100234' });
    f.order('b', { number: 'EBD-100999', deleted: true });
    f.order('c', { number: 'EBD-9_34', store: 's1' });
    f.order('d', { number: 'EBD-200234', store: 's2' });
    expect(searchOrderNumbers(f.db, 's1', '0023')).toEqual(['a']);
    expect(searchOrderNumbers(f.db, 's1', 'ebd-1')).toEqual(['a']); // ILIKE for ASCII
    expect(searchOrderNumbers(f.db, 's1', '9_3')).toEqual(['c']);
    expect(searchOrderNumbers(f.db, 's1', '%')).toEqual([]);
    expect(searchOrderNumbers(f.db, 's1', '')).toEqual([]);
  });
});

describe('every writer keeps the index fresh (triggers mark, search flushes)', () => {
  const find = (db: ReturnType<typeof fx>['db'], q: string) =>
    searchProductIdSet(db, 's1', q, { scope: 'admin' }).ids;
  const ins = (raw: ReturnType<typeof fx>['raw'], id: string, extra = '') =>
    raw.exec(
      `INSERT INTO products (id, store_id, name, slug, price) VALUES ('${id}', 's1', 'plain ${id}', '${id}', 1) ${extra}`
    );

  it('raw UPDATE of each indexed column, raw INSERT, bulk INSERT..SELECT, raw DELETE: the next search sees it, no explicit index call', () => {
    const f = fx();
    ins(f.raw, 'p1');
    expect(find(f.db, 'plain')).toEqual(['p1']);
    for (const [col, word] of [
      ['name', 'zzname'],
      ['name_ar', 'زززاسم'],
      ['search_terms', 'zzterms'],
      ['description', 'zzdesc'],
      ['description_ar', 'زززوصف'],
      ['sku', 'zzsku'],
    ] as const) {
      f.raw.exec(`UPDATE products SET ${col} = '${word}' WHERE id = 'p1'`);
      expect(find(f.db, word), col).toEqual(['p1']);
    }
    f.raw.exec(
      `INSERT INTO products (id, store_id, name, slug, price) SELECT 'b' || value, 's1', 'bulkitem', 'b' || value, 1 FROM (SELECT 1 AS value UNION SELECT 2 UNION SELECT 3)`
    );
    expect(find(f.db, 'bulkitem').sort()).toEqual(['b1', 'b2', 'b3']);
    f.raw.exec(`DELETE FROM products WHERE id = 'b2'`);
    expect(find(f.db, 'bulkitem').sort()).toEqual(['b1', 'b3']);
    f.raw.exec(`UPDATE products SET price = 5 WHERE id = 'p1'`); // an unindexed column does not even mark it
    expect(f.raw.prepare(`SELECT count(*) n FROM search_dirty`).get()).toEqual({ n: 0 });
    expect(verifyProductIndex(f.db, 's1')).toEqual({ missing: [], orphaned: [], stale: [] });
  });

  it('prisma-lite create / update / updateMany / upsert / delete / nested create all reach the index', async () => {
    const f = fx();
    const lite = createPrismaLite(META, nodeSqlRunner(f.raw), 'store-do', { storeId: 's1' });
    await lite.product.create({ data: { id: 'x1', name: 'lite alpha', slug: 'x1', price: 1 } });
    expect(find(f.db, 'alpha')).toEqual(['x1']);
    await lite.product.update({ where: { id: 'x1' }, data: { name: 'lite beta' } });
    expect(find(f.db, 'alpha')).toEqual([]);
    expect(find(f.db, 'beta')).toEqual(['x1']);
    await lite.product.updateMany({ where: { storeId: 's1' }, data: { searchTerms: 'gamma' } });
    expect(find(f.db, 'gamma')).toEqual(['x1']);
    await lite.product.upsert({
      where: { id: 'x2' },
      create: { id: 'x2', name: 'lite delta', slug: 'x2', price: 1 },
      update: {},
    });
    expect(find(f.db, 'delta')).toEqual(['x2']);
    await lite.product.delete({ where: { id: 'x2' } });
    expect(find(f.db, 'delta')).toEqual([]);
  });

  it('customers and guest orders follow raw writes too (rename, phone change, delete, order claimed by a customer)', () => {
    const f = fx();
    f.customer('c1', 'Old', 'Name', { phone: '01011111111' });
    f.order('g1', { ship: { firstName: 'Guesty', phone: '01022222222' } });
    expect(matchingCustomers(f.db, 's1', 'old').userIds).toEqual(['c1']);
    f.raw.exec(`UPDATE customers SET first_name = 'Fresh', phone = '01033333333' WHERE id = 'c1'`);
    expect(matchingCustomers(f.db, 's1', 'old').userIds).toEqual([]);
    expect(matchingCustomers(f.db, 's1', 'fresh').userIds).toEqual(['c1']);
    expect(matchingCustomers(f.db, 's1', '01033333333').userIds).toEqual(['c1']);
    expect(matchingCustomers(f.db, 's1', 'guesty').guestOrderIds).toEqual(['g1']);
    f.raw.exec(`UPDATE orders SET customer_id = 'c1' WHERE id = 'g1'`);
    expect(matchingCustomers(f.db, 's1', 'guesty').guestOrderIds).toEqual([]);
    f.raw.exec(`DELETE FROM customers WHERE id = 'c1'`);
    expect(matchingCustomers(f.db, 's1', 'fresh').userIds).toEqual([]);
  });

  it('backfill: an index installed on a store that already has rows indexes them all on first use', () => {
    const raw = openSqlite();
    const db = nodeSyncSql(raw);
    raw.exec(
      `INSERT INTO products (id, store_id, name, slug, price) VALUES ('old1', 's1', 'legacy ring', 'old1', 1)`
    );
    raw.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('oc', 's1', 'Legacy', 'Cust')`
    );
    ensureSearchIndex(db);
    ensureSearchIndex(db); // idempotent
    expect(searchProductIdSet(db, 's1', 'legacy', { scope: 'admin' }).ids).toEqual(['old1']);
    expect(matchingCustomers(db, 's1', 'legacy').userIds).toEqual(['oc']);
    expect(flushSearchIndex(db)).toBe(0);
  });

  it('static guard: every column the product document reads is in the product UPDATE trigger', () => {
    const trig = SEARCH_STATEMENTS.find(s => s.includes('search_products_au'))!;
    for (const c of [
      'name',
      'name_ar',
      'search_terms',
      'description',
      'description_ar',
      'sku',
      'store_id',
    ])
      expect(trig, c).toMatch(new RegExp(`UPDATE OF [^]*\\b${c}\\b[^]* ON products`));
  });
});
