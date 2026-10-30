import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { storeTables } from '../src/cf/store-do/tables';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import {
  STORE_DO_REGISTRY,
  unclassifiedTables,
  mediaSurface,
  ciSurface,
  identitySurface,
  suppressionSurface,
  storeDoSurface,
  ciBuyerIndexKey,
  gzipText,
  gunzipText,
  ciStoresFor,
  runErasure,
  runExport,
  ledgerKey,
  ErasureDisabledError,
  type CustomerSubject,
  type MerchantSubject,
  type IdentityPort,
  type SuppressionPort,
  type R2BucketLike,
  type TableClass,
} from '../src/cf/erasure';
import {
  eraseCustomerRows,
  exportCustomerRows,
  countCustomerRows,
} from '../src/cf/erasure/store-do-sql';

const e = env as unknown as {
  STORE_DO: DurableObjectNamespace<StoreDO>;
  STORE_BACKUPS: R2Bucket;
  MEDIA_BUCKET: R2Bucket;
  CI_BUCKET: R2Bucket;
  PDPL_CF_ERASURE_ENABLED?: string;
};
const r2 = (b: R2Bucket) => b as unknown as R2BucketLike;
const now = Date.now();
const seed = (id: string) =>
  e.STORE_DO.get(e.STORE_DO.idFromName(id)).seed({
    store: { id, slug: id, name: id, currency: 'EGP', createdAt: now, updatedAt: now },
    products: [
      {
        id: `${id}-p`,
        storeId: id,
        name: 'P',
        slug: 'p',
        price: 1,
        inventory: 1,
        status: 'active',
        hasVariants: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

const BK = 'ab'.padEnd(64, '1');
const OTHER = 'cd'.padEnd(64, '2');
const customer = (over: Partial<CustomerSubject> = {}): CustomerSubject => ({
  kind: 'customer',
  requestId: 'req-c',
  buyerKey: BK,
  email: 'Buyer@Example.com',
  userId: 'u-buyer',
  ...over,
});
const merchant = (over: Partial<MerchantSubject> = {}): MerchantSubject => ({
  kind: 'merchant',
  requestId: 'req-m',
  storeId: 'er-store',
  ownerUserId: 'u-owner',
  ...over,
});

describe('registry contract with the phase-1 schema', () => {
  // The StoreDO carries the full generated cf-schema (122 tables) and the registry is generated from the same
  // classification (CF-ERASE-3), so a customer subject is served. A table the registry does not know STILL fails closed:
  // a customer subject must never answer "nothing found" for data it cannot classify.
  it('unclassifiedTables names every live table the registry does not cover', () => {
    expect(unclassifiedTables(['products', 'customers'], { products: { kind: 'no-pii' } })).toEqual(
      ['customers']
    );
  });
  it('the registry covers every table of the live DO schema', async () => {
    await seed('er-covered');
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName('er-covered'));
    const live = await runInDurableObject(stub, async d => storeTables(d.ctx.storage.sql));
    expect(live.length).toBeGreaterThan(100);
    expect(unclassifiedTables(live)).toEqual([]);
  });
  it('a customer export/erase is served on the full schema, and refused (closed) once the DO holds a table the registry lacks', async () => {
    await seed('er-closed');
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName('er-closed'));
    const out = await stub.exportSubject(customer());
    expect(out.tables).toBeDefined(); // served: no ERASURE_REGISTRY_INCOMPLETE
    // Caught inside the DO: an exception that crosses the RPC edge is also reported by the pool as unhandled.
    const refusal = (call: (d: StoreDO) => unknown) =>
      runInDurableObject(stub, async d => {
        d.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS zz_unclassified (id TEXT PRIMARY KEY)');
        try {
          await call(d);
          return 'allowed';
        } catch (err) {
          return (err as Error).message;
        }
      });
    expect(await refusal(d => d.exportSubject(customer()))).toMatch(/ERASURE_REGISTRY_INCOMPLETE/);
    expect(await refusal(d => d.eraseSubject(customer()))).toMatch(/ERASURE_REGISTRY_INCOMPLETE/);
    const all = await stub.exportSubject(merchant({ storeId: 'er-closed' }));
    expect(Object.keys(all.tables).length).toBeGreaterThan(100);
    expect(all.tables.products).toHaveLength(1);
  });
  it('a scrub entry overwrites every column it matches on (else the row would still identify the buyer)', () => {
    for (const c of Object.values(STORE_DO_REGISTRY)) {
      if (c.kind !== 'customer-pii' || c.action !== 'scrub') continue;
      for (const col of Object.values(c.match)) expect(Object.keys(c.scrub ?? {})).toContain(col);
    }
  });
});

describe('InstaPay order receipts in a customer erasure (Ruling INSTAPAY-DO-1)', () => {
  it("the subject's receipts lose their personal fields and are marked for screenshot deletion; another buyer's are untouched", async () => {
    const store = 'er-receipts';
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName(store));
    await stub.moneyOp(store, 'cancel', encodeRpc({ orderId: 'nope' })); // binds the store
    await runInDurableObject(stub, async (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO customers (id, store_id, first_name, last_name, email) VALUES ('c-mine', ?, 'A', 'B', 'buyer@example.com'), ('c-other', ?, 'C', 'D', 'o@x.eg')",
        store,
        store
      );
      for (const [o, c, bk] of [
        ['o-mine', 'c-mine', BK],
        ['o-other', 'c-other', OTHER],
      ])
        sql.exec(
          `INSERT INTO orders (id, store_id, customer_id, buyer_key, order_number, status, payment_status, subtotal, total, shipping_address, billing_address)
           VALUES (?, ?, ?, ?, ?, 'awaiting_payment_confirmation', 'unpaid', 1, 1, '{}', '{}')`,
          o,
          store,
          c,
          bk,
          o
        );
      for (const o of ['o-mine', 'o-other'])
        sql.exec(
          `INSERT INTO instapay_order_receipts (id, store_id, order_id, storage_key, mime_type, size_bytes, sha256, status, payer_name, payer_mobile, note, extracted, created_at)
           VALUES (?, ?, ?, ?, 'image/png', 1, ?, 'submitted', 'Payer Name', '01000000000', 'hello', '{"a":1}', 1)`,
          `r-${o}`,
          store,
          o,
          `key-${o}`,
          `sha-${o}`
        );
    });
    await stub.eraseSubject(customer());
    await runInDurableObject(stub, async (_i, state) => {
      const row = (id: string) =>
        state.storage.sql.exec('SELECT * FROM instapay_order_receipts WHERE id = ?', id).one();
      const mine = row('r-o-mine');
      expect(mine.payer_name).toBeNull();
      expect(mine.payer_mobile).toBeNull();
      expect(mine.note).toBeNull();
      expect(mine.extracted).toBeNull();
      expect(mine.personal_scrubbed_at).not.toBeNull(); // the sweep now lists its screenshot for deletion
      expect(mine.status).toBe('submitted'); // the money evidence stays
      const other = row('r-o-other');
      expect(other.payer_name).toBe('Payer Name');
      expect(other.personal_scrubbed_at).toBeNull();
    });
    const swept = (await stub.moneyOp(store, 'receiptSweep', encodeRpc({}))) as {
      ok: true;
      json: string;
    };
    expect(decodeRpc<any>(swept.json).dueImages.map((d: any) => d.storageKey)).toEqual([
      'key-o-mine',
    ]);
  });
});

describe('surface: store-do (customer rows, registry driven)', () => {
  const REG: Record<string, TableClass> = {
    er_customers: {
      kind: 'customer-pii',
      match: { buyerKey: 'buyer_key', email: 'email', userId: 'user_id' },
      action: 'delete',
    },
    er_ship_addr: {
      kind: 'customer-pii',
      match: { buyerKey: 'buyer_key' },
      action: 'scrub',
      scrub: { buyer_key: '[erased]', line1: '[erased]' },
    },
  };
  it('exports, erases and verifies only the subject, keeps scrubbed rows, leaves other buyers', async () => {
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName('er-sql'));
    await runInDurableObject(stub, async (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        'CREATE TABLE er_customers (id INTEGER PRIMARY KEY, buyer_key TEXT, email TEXT, user_id TEXT)'
      );
      sql.exec('CREATE TABLE er_ship_addr (id INTEGER PRIMARY KEY, buyer_key TEXT, line1 TEXT)');
      sql.exec(
        "INSERT INTO er_customers (buyer_key,email,user_id) VALUES (?, 'buyer@example.com', NULL), (?, 'o@x.eg', NULL), (NULL, NULL, 'u-buyer')",
        BK,
        OTHER
      );
      sql.exec(
        "INSERT INTO er_ship_addr (buyer_key,line1) VALUES (?, '1 Nile St'), (?, '2 Nile St')",
        BK,
        OTHER
      );
      const s = customer();
      expect(exportCustomerRows(sql, s, REG).er_customers).toHaveLength(2); // by key OR email OR user id
      expect(countCustomerRows(sql, s, REG)).toBe(3);
      const erased = state.storage.transactionSync(() => eraseCustomerRows(sql, s, REG));
      expect(erased).toEqual({ er_customers: 2, er_ship_addr: 1 });
      expect(countCustomerRows(sql, s, REG)).toBe(0);
      expect(sql.exec('SELECT count(*) AS n FROM er_customers').one().n).toBe(1); // the other buyer
      expect(
        sql.exec("SELECT line1 FROM er_ship_addr WHERE buyer_key = '[erased]'").one().line1
      ).toBe('[erased]');
      expect(
        sql.exec('SELECT line1 FROM er_ship_addr WHERE buyer_key = ?', OTHER).one().line1
      ).toBe('2 Nile St');
    });
  });
  it('merchant erase wipes the whole DO: rows, tables and alarm', async () => {
    await seed('er-store');
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName('er-store'));
    await stub.ensureBackupAlarm();
    const r = await stub.eraseSubject(merchant());
    expect(r.erased.products).toBe(1);
    expect(r.remaining).toBe(0);
    await runInDurableObject(stub, async (_i, state) =>
      expect(await state.storage.getAlarm()).toBeNull()
    );
  });
  it('the surface fans out over the subject stores and sums the stub results', async () => {
    const calls: string[] = [];
    const surf = storeDoSurface(
      id => ({
        exportSubject: async () => ({ tables: { t: [{ a: id }] } }),
        eraseSubject: async () => (
          calls.push(id),
          { erased: { t: 2 }, remaining: id === 's2' ? 1 : 0 }
        ),
      }),
      async () => ['s1', 's2']
    );
    const r = await surf.eraseSubject(customer());
    expect(calls).toEqual(['s1', 's2']);
    expect(r).toMatchObject({ erased: 4, remaining: 1 });
    expect((await surf.exportSubject(customer())).records).toBe(2);
  });
});

describe('surface: media (R2)', () => {
  it('merchant erase deletes exactly stores/<id>/ (prefix exact), customers touch nothing', async () => {
    for (const k of ['stores/m1/a.jpg', 'stores/m1/sub/b.jpg', 'stores/m10/c.jpg'])
      await e.MEDIA_BUCKET.put(k, 'x');
    const s = mediaSurface(r2(e.MEDIA_BUCKET));
    expect((await s.eraseSubject(customer())).erased).toBe(0);
    expect((await e.MEDIA_BUCKET.list({ prefix: 'stores/' })).objects).toHaveLength(3);
    expect((await s.exportSubject(merchant({ storeId: 'm1' }))).records).toBe(2);
    const r = await s.eraseSubject(merchant({ storeId: 'm1' }));
    expect(r).toMatchObject({ erased: 2, remaining: 0 });
    expect((await e.MEDIA_BUCKET.list({ prefix: 'stores/' })).objects.map(o => o.key)).toEqual([
      'stores/m10/c.jpg',
    ]);
  });
});

describe('surface: customer intelligence (R2)', () => {
  // storeId rides every real row; the store-scoped customer erase (Ruling CI-8) matches on it.
  const ev = (buyerKey: string | null, n: number, storeId = 'ci-1') =>
    JSON.stringify({ type: 'order.placed', buyerKey, n, storeId });
  async function fixture() {
    const A = 'outcomes/v1/store=ci-1/dt=2026-11-01/a.ndjson.gz';
    const B = 'outcomes/v1/store=ci-2/dt=2026-11-01/b.ndjson.gz';
    const C = 'outcomes/v1/store=ci-3/dt=2026-11-01/c.ndjson.gz';
    await e.CI_BUCKET.put(
      A,
      await gzipText([ev(BK, 1), ev(OTHER, 2), ev(null, 3)].join('\n') + '\n')
    );
    await e.CI_BUCKET.put(B, await gzipText(ev(BK, 4, 'ci-2') + '\n')); // only this buyer: file goes away
    await e.CI_BUCKET.put(C, await gzipText(ev(OTHER, 5, 'ci-3') + '\n'));
    await e.CI_BUCKET.put(ciBuyerIndexKey(BK), JSON.stringify({ partitions: [A, B] }));
    return { A, B, C };
  }
  it('customer erase drops only that buyer rows, deletes empty files and the index, verifies by re-reading', async () => {
    const { A, B, C } = await fixture();
    const before = await (await e.CI_BUCKET.get(C))!.arrayBuffer();
    const s = ciSurface(r2(e.CI_BUCKET));
    expect((await s.exportSubject(customer())).records).toBe(2);
    expect(await ciStoresFor(r2(e.CI_BUCKET), BK)).toEqual(['ci-1', 'ci-2']);
    const r = await s.eraseSubject(customer());
    expect(r).toMatchObject({ erased: 2, remaining: 0 });
    const kept = (await gunzipText(await (await e.CI_BUCKET.get(A))!.arrayBuffer()))
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(kept.map(k => k.n)).toEqual([2, 3]);
    expect(await e.CI_BUCKET.get(B)).toBeNull();
    expect(await e.CI_BUCKET.get(ciBuyerIndexKey(BK))).toBeNull();
    expect(new Uint8Array(await (await e.CI_BUCKET.get(C))!.arrayBuffer())).toEqual(
      new Uint8Array(before)
    );
  });
  it('merchant erase removes that store only, other stores byte-identical', async () => {
    await e.CI_BUCKET.put(
      'outcomes/v1/store=ci-m/dt=2026-11-01/x.ndjson.gz',
      await gzipText(ev(BK, 1) + '\n')
    );
    await e.CI_BUCKET.put(
      'outcomes/v1/store=ci-m2/dt=2026-11-01/x.ndjson.gz',
      await gzipText(ev(BK, 2) + '\n')
    );
    const r = await ciSurface(r2(e.CI_BUCKET)).eraseSubject(merchant({ storeId: 'ci-m' }));
    expect(r).toMatchObject({ erased: 1, remaining: 0 });
    expect(
      await e.CI_BUCKET.get('outcomes/v1/store=ci-m2/dt=2026-11-01/x.ndjson.gz')
    ).not.toBeNull();
  });
  it('fails loud when an erase did not take (a dropped write cannot pass as erased)', async () => {
    await fixture();
    const real = r2(e.CI_BUCKET);
    // A bucket whose writes and deletes are silently dropped: the post-erase re-read must catch it.
    const wrapped: R2BucketLike = {
      get: k => real.get(k),
      list: o => real.list(o),
      put: async () => undefined,
      delete: async () => undefined,
    };
    // The store-scoped erase (Ruling CI-8) rewrites by compare-and-set, so a dropped write surfaces as
    // contention (a failed surface) instead of a silent remaining > 0.
    await expect(ciSurface(wrapped).eraseSubject(customer())).rejects.toThrow(/contention/);
  });
});

describe('surfaces: identity + email suppression (ports)', () => {
  it('identity (contract v1.1): erased is a boolean, remaining > 0 is a failed surface, a repeat is erased:false remaining:0', async () => {
    const seen: string[] = [];
    const gone = new Set<string>();
    const port: IdentityPort = {
      eraseUser: async (u, req) => {
        seen.push(`${u}:${req}`);
        const had = !gone.has(u);
        gone.add(u);
        return { erased: had, remaining: u === 'bad' ? 1 : 0 };
      },
      // the v1.1 fixture shape: one array per table, no secrets
      exportUser: async u => ({
        users: u === 'nobody' ? [] : [{ id: u, email: 'a@x.eg', status: 'active' }],
        sessions: [],
        refresh_tokens: [],
        verification_tokens: [],
        passkey_credentials: [],
      }),
    };
    const s = identitySurface(port);
    const r = await s.eraseSubject(merchant({ staffUserIds: ['st1', 'bad'] }));
    expect(seen).toEqual(['u-owner:req-m', 'st1:req-m', 'bad:req-m']);
    expect(r).toMatchObject({ erased: 3, remaining: 1 });
    // the job turns remaining > 0 into a failed run
    const failed = await runErasure(
      { PDPL_CF_ERASURE_ENABLED: 'true', STORE_BACKUPS: e.STORE_BACKUPS },
      [s],
      merchant({ requestId: 'req-id-bad', staffUserIds: ['bad'] })
    );
    expect(failed.status).toBe('failed');
    expect(failed.errors[0]).toMatch(/identity: 1 record/);
    // idempotent repeat: nothing erased, nothing remaining, no error
    const again = await s.eraseSubject(merchant({ requestId: 'req-m2' }));
    expect(again).toMatchObject({ erased: 0, remaining: 0 });
    const ex = await s.exportSubject(customer());
    expect(ex.records).toBe(1);
    expect(Object.keys(JSON.parse(ex.ndjson.trim()).data).sort()).toEqual([
      'passkey_credentials',
      'refresh_tokens',
      'sessions',
      'users',
      'verification_tokens',
    ]);
    expect((await s.exportSubject(customer({ userId: undefined }))).records).toBe(0);
  });
  it('suppression: tombstones the address (suppression stays) and verifies none is left in plain', async () => {
    let plain = 2;
    const port: SuppressionPort = {
      tombstone: async () => ((plain = 0), { rows: 2 }),
      exportFor: async email => [{ email }],
      remainingPlain: async () => plain,
    };
    const s = suppressionSurface(port);
    expect(await s.eraseSubject(customer())).toMatchObject({ erased: 2, remaining: 0 });
    expect(await s.eraseSubject(customer({ email: undefined }))).toMatchObject({
      erased: 0,
      note: 'no email on subject',
    });
  });
});

describe('job: flag, ledger, idempotency, failure, export', () => {
  const okSurface = (name: string, remaining = 0, boom = false) => ({
    name,
    exportSubject: async () => ({ surface: name, ndjson: '{"a":1}\n', records: 1 }),
    eraseSubject: async () => {
      if (boom) throw new Error('down');
      return { surface: name, erased: 1, remaining };
    },
  });
  const on = { PDPL_CF_ERASURE_ENABLED: 'true', STORE_BACKUPS: e.STORE_BACKUPS };

  it('refuses to run while the flag is off', async () => {
    await expect(
      runErasure({ STORE_BACKUPS: e.STORE_BACKUPS }, [okSurface('a')], customer())
    ).rejects.toBeInstanceOf(ErasureDisabledError);
    await expect(
      runExport({ STORE_BACKUPS: e.STORE_BACKUPS }, [okSurface('a')], customer())
    ).rejects.toBeInstanceOf(ErasureDisabledError);
  });
  it('records a done ledger entry without the subject identifiers, and a replay short-circuits', async () => {
    let calls = 0;
    const s = {
      ...okSurface('a'),
      eraseSubject: async () => (calls++, { surface: 'a', erased: 1, remaining: 0 }),
    };
    const first = await runErasure(on, [s], customer({ requestId: 'req-done' }));
    expect(first.status).toBe('done');
    const raw = await (await e.STORE_BACKUPS.get(ledgerKey('req-done')))!.text();
    expect(raw).not.toContain(BK);
    expect(raw).not.toContain('example.com');
    await runErasure(on, [s], customer({ requestId: 'req-done' }));
    expect(calls).toBe(1);
  });
  it('one failing surface does not stop the rest, fails the job and alerts', async () => {
    const alerts: string[] = [];
    const entry = await runErasure(
      on,
      [okSurface('a', 0, true), okSurface('b'), okSurface('c', 2)],
      customer({ requestId: 'req-bad' }),
      {
        alert: async t => void alerts.push(t),
      }
    );
    expect(entry.status).toBe('failed');
    expect(entry.surfaces.map(x => x.surface)).toEqual(['b', 'c']);
    expect(entry.errors).toEqual(['a: down', 'c: 2 record(s) remain after erase']);
    expect(alerts).toEqual(['PDPL erasure FAILED']);
    // a failed entry is retried on replay, not skipped
    const retry = await runErasure(on, [okSurface('a')], customer({ requestId: 'req-bad' }));
    expect(retry.status).toBe('done');
  });
  it('export writes one NDJSON per surface plus a manifest', async () => {
    const out = await runExport(
      on,
      [okSurface('a'), okSurface('b')],
      merchant({ requestId: 'req-x' })
    );
    expect(out.parts.map(p => p.surface)).toEqual(['a', 'b']);
    const m = JSON.parse(await (await e.STORE_BACKUPS.get('exports/req-x/manifest.json'))!.text());
    expect(m.parts).toHaveLength(2);
    expect(await (await e.STORE_BACKUPS.get('exports/req-x/a.ndjson'))!.text()).toBe('{"a":1}\n');
  });
});
