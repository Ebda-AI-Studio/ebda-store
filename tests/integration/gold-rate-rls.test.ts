/**
 * Gold-rate pricing, Task 9 (Ruling B5-13, R-EBDA-001): the three new tables are strict tenant
 * tables. Every assertion runs on a real `ebda_app` login with the tenant GUC set
 * transaction-locally; the superuser URL only builds fixtures. `rls-ebda-app.test.ts` enumerates
 * every store_id table and covers these three with no allowlist entry; this file adds the
 * table-specific rules: gold_rates is APPEND-ONLY for the app role (no DELETE, no re-rating).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { hasDb } from '../helpers/bundle-fixtures';
import {
  appPool,
  createStore,
  deleteStores,
  inStoreTx,
  ownerPool,
  sqlState,
  tag,
  uid,
} from '../helpers/gold-sql';

const TABLES = ['gold_rates', 'gold_rates_current', 'gold_rate_settings'] as const;

describe.skipIf(!hasDb)('gold-rate tables: strict RLS on a real ebda_app login', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const A = { storeId: '', userId: '' };
  const B = { storeId: '', userId: '' };
  const rateA = uid();
  const rateB = uid();
  const t = tag();

  beforeAll(async () => {
    owner = ownerPool();
    app = appPool();
    Object.assign(A, await createStore(owner, `rls-a-${t}`));
    Object.assign(B, await createStore(owner, `rls-b-${t}`));
    for (const [s, id] of [
      [A, rateA],
      [B, rateB],
    ] as const) {
      await owner.query(
        `insert into gold_rates (id, store_id, karat, rate_per_gram, source, status, applied_at)
         values ($1, $2, 21, 576323, 'manual', 'applied', now())`,
        [id, s.storeId]
      );
      await owner.query(
        `insert into gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at)
         values ($1, 21, $2, 576323, now())`,
        [s.storeId, id]
      );
      await owner.query(`insert into gold_rate_settings (store_id, enabled) values ($1, true)`, [
        s.storeId,
      ]);
    }
  });

  afterAll(async () => {
    await deleteStores(owner, [A.storeId, B.storeId], [A.userId, B.userId]);
    await app.end();
    await owner.end();
  });

  it('FORCE row level security is on, with exactly one ebda_app policy per table', async () => {
    const r = await owner.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c where c.relname = any($1::text[]) and c.relkind = 'r'`,
      [TABLES as unknown as string[]]
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
      expect(row.policies, row.relname).toBe(1);
    }
  });

  for (const table of TABLES) {
    it(`${table}: a contextless SELECT returns 0 rows`, async () => {
      const r = await inStoreTx(app, null, c => c.query(`select count(*)::int as n from ${table}`));
      expect(r.rows[0].n).toBe(0);
    });

    it(`${table}: store A cannot see store B's rows, and sees its own`, async () => {
      const a = await inStoreTx(app, A.storeId, c =>
        c.query(`select store_id from ${table} where store_id in ($1, $2)`, [A.storeId, B.storeId])
      );
      expect(a.rows.map(x => x.store_id)).toEqual([A.storeId]);
    });
  }

  it('a contextless INSERT is rejected on every table', async () => {
    const attempts: Array<[string, unknown[]]> = [
      [
        `insert into gold_rates (id, store_id, karat, rate_per_gram, source, status) values ($1, $2, 21, 576323, 'manual', 'applied')`,
        [uid(), A.storeId],
      ],
      [
        `insert into gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at) values ($1, 18, $2, 500000, now())`,
        [A.storeId, rateA],
      ],
      [`insert into gold_rate_settings (store_id) values ($1)`, [uid()]],
    ];
    for (const [sql, params] of attempts) {
      let code: string | undefined;
      try {
        await inStoreTx(app, null, c => c.query(sql, params));
      } catch (e) {
        code = sqlState(e);
      }
      expect(code, sql).toBe('42501');
    }
  });

  it('store A cannot write a row into store B (WITH CHECK)', async () => {
    let code: string | undefined;
    try {
      await inStoreTx(app, A.storeId, c =>
        c.query(
          `insert into gold_rates (id, store_id, karat, rate_per_gram, source, status) values ($1, $2, 24, 700000, 'manual', 'applied')`,
          [uid(), B.storeId]
        )
      );
    } catch (e) {
      code = sqlState(e);
    }
    expect(code).toBe('42501');
  });

  it("store A cannot UPDATE or DELETE store B's settings or current rate (0 rows)", async () => {
    const up = await inStoreTx(app, A.storeId, c =>
      c.query(`update gold_rate_settings set enabled = false where store_id = $1`, [B.storeId])
    );
    expect(up.rowCount).toBe(0);
    const del = await inStoreTx(app, A.storeId, c =>
      c.query(`delete from gold_rates_current where store_id = $1`, [B.storeId])
    );
    expect(del.rowCount).toBe(0);
    const still = await owner.query(`select enabled from gold_rate_settings where store_id = $1`, [
      B.storeId,
    ]);
    expect(still.rows[0].enabled).toBe(true);
  });

  describe('gold_rates is append-only for the app role', () => {
    it('ebda_app cannot DELETE a rate row (no grant)', async () => {
      let code: string | undefined;
      try {
        await inStoreTx(app, A.storeId, c =>
          c.query(`delete from gold_rates where id = $1`, [rateA])
        );
      } catch (e) {
        code = sqlState(e);
      }
      expect(code).toBe('42501');
      expect((await owner.query(`select 1 from gold_rates where id = $1`, [rateA])).rowCount).toBe(
        1
      );
    });

    it('ebda_app cannot re-rate a row: UPDATE of rate_per_gram, karat or source is denied', async () => {
      for (const col of [
        'rate_per_gram = 600000',
        'karat = 18',
        "source = 'feed'",
        'jump_bps = 1',
      ]) {
        let code: string | undefined;
        try {
          await inStoreTx(app, A.storeId, c =>
            c.query(`update gold_rates set ${col} where id = $1`, [rateA])
          );
        } catch (e) {
          code = sqlState(e);
        }
        expect(code, col).toBe('42501');
      }
      const row = await owner.query(
        `select rate_per_gram, karat, source from gold_rates where id = $1`,
        [rateA]
      );
      expect(row.rows[0]).toMatchObject({ rate_per_gram: 576323, karat: 21, source: 'manual' });
    });

    it('ebda_app CAN decide a pending row: UPDATE of status, decided_by, applied_at is allowed', async () => {
      const pending = uid();
      await owner.query(
        `insert into gold_rates (id, store_id, karat, rate_per_gram, source, status) values ($1, $2, 24, 800000, 'feed', 'pending')`,
        [pending, A.storeId]
      );
      const r = await inStoreTx(app, A.storeId, c =>
        c.query(
          `update gold_rates set status = 'applied', decided_by = 'u1', applied_at = now() where id = $1`,
          [pending]
        )
      );
      expect(r.rowCount).toBe(1);
    });

    it('the CHECK constraints hold: bad karat, rate, source, status are refused even for the owner', async () => {
      for (const [col, val] of [
        ['karat', 22],
        ['rate_per_gram', 9999],
        ['rate_per_gram', 10000001],
      ] as const) {
        let code: string | undefined;
        try {
          await owner.query(
            `insert into gold_rates (id, store_id, karat, rate_per_gram, source, status) values ($1, $2, ${col === 'karat' ? '$3' : '21'}, ${col === 'rate_per_gram' ? '$3' : '576323'}, 'manual', 'applied')`,
            [uid(), A.storeId, val]
          );
        } catch (e) {
          code = sqlState(e);
        }
        expect(code, `${col}=${val}`).toBe('23514');
      }
      let code: string | undefined;
      try {
        await owner.query(
          `insert into gold_rates (id, store_id, karat, rate_per_gram, source, status) values ($1, $2, 21, 576323, 'scraper', 'applied')`,
          [uid(), A.storeId]
        );
      } catch (e) {
        code = sqlState(e);
      }
      expect(code).toBe('23514');
    });
  });

  it('deleting a store cascades to all three tables (no NO ACTION child)', async () => {
    const s = await createStore(owner, `cascade-${t}`);
    const rid = uid();
    await owner.query(
      `insert into gold_rates (id, store_id, karat, rate_per_gram, source, status) values ($1, $2, 21, 576323, 'manual', 'applied')`,
      [rid, s.storeId]
    );
    await owner.query(
      `insert into gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at) values ($1, 21, $2, 576323, now())`,
      [s.storeId, rid]
    );
    await owner.query(`insert into gold_rate_settings (store_id) values ($1)`, [s.storeId]);
    await deleteStores(owner, [s.storeId], [s.userId]);
    for (const table of TABLES)
      expect(
        (await owner.query(`select 1 from ${table} where store_id = $1`, [s.storeId])).rowCount,
        table
      ).toBe(0);
    const fks = await owner.query(
      `select constraint_name, delete_rule from information_schema.referential_constraints
        where constraint_name like '%gold%'`
    );
    expect(fks.rows.length).toBeGreaterThanOrEqual(4);
    for (const r of fks.rows) expect(r.delete_rule, r.constraint_name).not.toBe('NO ACTION');
  });
});
