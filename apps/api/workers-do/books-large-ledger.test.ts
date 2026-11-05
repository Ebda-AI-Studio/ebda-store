import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, doSyncSql, encodeRpc, postJournalEntry } from '@ebda-src/repo';
import { reverseEntry } from '../../../packages/repo/src/do/ledger';
import type { StoreDO } from '../src/cf/store-do/store-do';

// NZ-17 slice 2, plan item 3: the accounting reports on a LARGE ledger on the DO SQLite path. The Postgres suite
// (financial-reports, journal-service, accounting-idempotency) proved the period windows on a dozen rows. Here thousands of
// lines across months are seeded, and every figure is compared with a total summed in this file, in integer piastres.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const money = async <T>(
  stub: ReturnType<typeof stubFor>,
  store: string,
  name: string,
  args: object
) => {
  const a = (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
  if (!a.ok) throw new Error(`${name}: ${a.code}`);
  return decodeRpc<T>(a.json);
};

type Totals = { rows: Array<{ code: string; type: string; debit: number; credit: number }> };
const at = (iso: string) => Date.parse(iso);
const CODES: Array<[string, string]> = [
  ['1000', 'asset'],
  ['1200', 'asset'],
  ['2100', 'liability'],
  ['3000', 'equity'],
  ['4000', 'revenue'],
  ['5000', 'expense'],
];

/** Deterministic PRNG (mulberry32) so a failure replays. */
function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** The expected figures, summed here, independently of the SQL under test. */
type Exp = Map<string, { d: number; c: number }>;
const bump = (m: Exp, code: string, d: number, c: number) => {
  const x = m.get(code) ?? { d: 0, c: 0 };
  x.d += d;
  x.c += c;
  m.set(code, x);
};

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const SALES_PER_MONTH = 500;

async function seedLedger(store: string) {
  const stub = stubFor(store);
  await stub.stockOp(store, 'setProduct', encodeRpc({ productId: 'nope', quantity: 0 })); // binds the store
  const random = rng(17);
  const monthly = new Map<string, Exp>();
  const all: Exp = new Map();
  const entryIds: Array<{ id: string; month: string; amount: number }> = [];

  await runInDurableObject(stub, (_i, state) => {
    const db = doSyncSql(state.storage);
    const ids: Record<string, string> = {};
    for (const [code, type] of CODES) {
      ids[code] = `acc-${code}`;
      db.run(
        `INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES (?, ?, ?, ?, ?, 1)`,
        [ids[code], store, code, code, type]
      );
    }
    db.run(`INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES (?, 1)`, [
      store,
    ]);
    const record = (month: string, code: string, d: number, c: number) => {
      bump(all, code, d, c);
      if (!monthly.has(month)) monthly.set(month, new Map());
      bump(monthly.get(month)!, code, d, c);
    };
    // Opening balance on the first instant of January.
    postJournalEntry(db, {
      storeId: store,
      source: 'opening_balance',
      sourceId: 'open',
      postedAt: at('2026-01-01T00:00:00.000Z'),
      lines: [
        { accountId: ids['1200'], debit: 5_000_000, credit: 0 },
        { accountId: ids['3000'], debit: 0, credit: 5_000_000 },
      ],
    });
    record('2026-01', '1200', 5_000_000, 0);
    record('2026-01', '3000', 0, 5_000_000);

    for (const month of MONTHS) {
      for (let i = 0; i < SALES_PER_MONTH; i++) {
        // Odd gross amounts; the 14% VAT is rounded to the piastre the way a sale posts it, net = gross - vat.
        const gross = 1_000 + Math.floor(random() * 2_000_000) * 1 + 1; // 1001 .. ~2,001,000 piastres
        const vat = Math.round((gross * 14) / 114);
        const net = gross - vat;
        const day = String(1 + (i % 27)).padStart(2, '0');
        const hour = String(i % 24).padStart(2, '0');
        const r = postJournalEntry(db, {
          storeId: store,
          source: 'order',
          sourceId: `${month}-${i}`,
          postedAt: at(`${month}-${day}T${hour}:30:00.000Z`),
          lines: [
            { accountId: ids['1000'], debit: gross, credit: 0 },
            { accountId: ids['4000'], debit: 0, credit: net },
            { accountId: ids['2100'], debit: 0, credit: vat },
          ],
        });
        record(month, '1000', gross, 0);
        record(month, '4000', 0, net);
        record(month, '2100', 0, vat);
        if (i % 25 === 0) entryIds.push({ id: r.entry.id, month, amount: gross });
        if (i % 5 === 0) {
          const cogs = Math.round(net * 0.37);
          postJournalEntry(db, {
            storeId: store,
            source: 'order',
            sourceId: `${month}-${i}:cogs`,
            postedAt: at(`${month}-${day}T${hour}:45:00.000Z`),
            lines: [
              { accountId: ids['5000'], debit: cogs, credit: 0 },
              { accountId: ids['1200'], debit: 0, credit: cogs },
            ],
          });
          record(month, '5000', cogs, 0);
          record(month, '1200', 0, cogs);
        }
      }
    }
  });
  return { stub, monthly, all, entryIds };
}

const fold = (maps: Exp[]): Exp => {
  const out: Exp = new Map();
  for (const m of maps) for (const [code, v] of m) bump(out, code, v.d, v.c);
  return out;
};
const byCode = (t: Totals) => new Map(t.rows.map(r => [r.code, r]));
const expectTotals = (t: Totals, exp: Exp) => {
  const got = byCode(t);
  for (const [code] of CODES) {
    expect(got.get(code)!.debit, `debit ${code}`).toBe(exp.get(code)?.d ?? 0);
    expect(got.get(code)!.credit, `credit ${code}`).toBe(exp.get(code)?.c ?? 0);
  }
};
/** The report folds of reports.service.ts (`netIncomeOf`, `balanceSheet`), over the DO's totals. */
const netIncomeOf = (t: Totals) => {
  const revenue = t.rows
    .filter(r => r.type === 'revenue')
    .reduce((s, r) => s + r.credit - r.debit, 0);
  const expenses = t.rows
    .filter(r => r.type === 'expense')
    .reduce((s, r) => s + r.debit - r.credit, 0);
  return { revenue, expenses, net: revenue - expenses };
};

describe('accounting reports on a large DO ledger', () => {
  it('trial balance, P&L per month and balance sheet match totals summed in the test, to the piastre', async () => {
    const { stub, monthly, all } = await seedLedger('led-reports');
    const nEntries = (
      await runInDurableObject(stub, (_i, s) =>
        s.storage.sql.exec(`SELECT count(*) AS n FROM journal_lines`).toArray()
      )
    )[0] as { n: number };
    expect(nEntries.n).toBeGreaterThan(3000);

    // Trial balance, all time: every account, and debit total equals credit total.
    const tb = await money<Totals>(stub, 'led-reports', 'accountTotals', {});
    expectTotals(tb, all);
    expect(tb.rows.reduce((s, r) => s + r.debit, 0)).toBe(
      tb.rows.reduce((s, r) => s + r.credit, 0)
    );

    // P&L for each month window (inclusive bounds) equals that month's own activity.
    for (const month of MONTHS) {
      const [y, m] = month.split('-').map(Number);
      const from = Date.UTC(y, m - 1, 1);
      const to = Date.UTC(y, m, 1) - 1;
      const t = await money<Totals>(stub, 'led-reports', 'accountTotals', {
        fromMs: from,
        toMs: to,
      });
      expectTotals(t, monthly.get(month)!);
      const exp = monthly.get(month)!;
      const rev = exp.get('4000')!.c;
      const cost = exp.get('5000')!.d;
      expect(netIncomeOf(t)).toEqual({ revenue: rev, expenses: cost, net: rev - cost });
    }

    // Balance sheet as of each month end: trialBalance(asOf) = fold of months to date; A = L + E + earnings exactly.
    for (let k = 0; k < MONTHS.length; k++) {
      const [y, m] = MONTHS[k].split('-').map(Number);
      const asOf = Date.UTC(y, m, 1) - 1;
      const t = await money<Totals>(stub, 'led-reports', 'accountTotals', { toMs: asOf });
      expectTotals(t, fold(MONTHS.slice(0, k + 1).map(x => monthly.get(x)!)));
      const sum = (type: string, sign: 1 | -1) =>
        t.rows.filter(r => r.type === type).reduce((s, r) => s + sign * (r.debit - r.credit), 0);
      const earnings = netIncomeOf(t).net;
      expect(sum('asset', 1)).toBe(sum('liability', -1) + sum('equity', -1) + earnings);
    }

    // Before the first entry every account is zero, not the all-time total.
    const before = await money<Totals>(stub, 'led-reports', 'accountTotals', {
      toMs: at('2025-12-31T23:59:59.999Z'),
    });
    for (const r of before.rows) expect([r.debit, r.credit]).toEqual([0, 0]);
  });

  it('period boundaries are inclusive on both ends', async () => {
    const { stub } = await seedLedger('led-bounds');
    const t = at('2026-03-01T00:30:00.000Z'); // sale i=0 of March
    const one = await money<Totals>(stub, 'led-bounds', 'accountTotals', { fromMs: t, toMs: t });
    const rev = byCode(one).get('4000')!.credit;
    expect(rev).toBeGreaterThan(0);
    const gross = byCode(one).get('1000')!.debit;
    expect(gross).toBe(rev + byCode(one).get('2100')!.credit);
  });

  it('daily close and period reconciliation: balanced, idempotent on repeat and on replayed postings', async () => {
    const { stub, monthly, all } = await seedLedger('led-close');
    const first = await money<{ debit: number; credit: number }>(
      stub,
      'led-close',
      'trialBalance',
      {}
    );
    expect(first.debit).toBe(first.credit);
    expect(first.debit).toBe([...all.values()].reduce((s, v) => s + v.d, 0));
    // Repeating the close reads the same figures, and replaying every posting (same source + sourceId) adds nothing.
    expect(await money(stub, 'led-close', 'trialBalance', {})).toEqual(first);
    await runInDurableObject(stub, (_i, state) => {
      const db = doSyncSql(state.storage);
      for (const month of MONTHS)
        for (let i = 0; i < SALES_PER_MONTH; i += 7) {
          const r = postJournalEntry(db, {
            storeId: 'led-close',
            source: 'order',
            sourceId: `${month}-${i}`,
            lines: [
              { accountId: 'acc-1000', debit: 999_999, credit: 0 },
              { accountId: 'acc-4000', debit: 0, credit: 999_999 },
            ],
          });
          if (r.created) throw new Error(`replay posted a second entry for ${month}-${i}`);
        }
    });
    expect(await money(stub, 'led-close', 'trialBalance', {})).toEqual(first);

    // Revenue-side credits (4000 + 2100) since the start of April = the sum of April..June net + vat.
    const since = Date.UTC(2026, 3, 1);
    const exp = fold(['2026-04', '2026-05', '2026-06'].map(x => monthly.get(x)!));
    const p = await money<{ total: number }>(stub, 'led-close', 'periodGlCredits', {
      sinceMs: since,
    });
    expect(p.total).toBe(exp.get('4000')!.c + exp.get('2100')!.c);
  });

  it('a reversal (the adjust path) nets to zero, reopens nothing, and is a no-op the second time; drafts never count', async () => {
    const { stub, all, entryIds } = await seedLedger('led-reverse');
    const before = await money<Totals>(stub, 'led-reverse', 'accountTotals', {});
    expectTotals(before, all);

    // Reverse ~20 sales per month spread across the ledger.
    const victims = entryIds.slice(0, 60);
    await runInDurableObject(stub, (_i, state) => {
      const db = doSyncSql(state.storage);
      for (const v of victims) {
        const r = reverseEntry(db, {
          storeId: 'led-reverse',
          entryId: v.id,
          reason: 'adjust',
          now: at('2026-07-01T00:00:00.000Z'),
        });
        if (!r.reversed) throw new Error('first reversal must apply');
        // Reversing again is a no-op (no second mirror).
        if (reverseEntry(db, { storeId: 'led-reverse', entryId: v.id }).reversed)
          throw new Error('second reversal posted');
      }
      // A draft entry with lines that would unbalance the books if it counted.
      db.run(
        `INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, status, created_at) VALUES ('draft1', 'led-reverse', 'JE-DRAFT', ?, 'manual', 'draft', ?)`,
        [at('2026-02-02T00:00:00.000Z'), 1]
      );
      db.run(
        `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, created_at) VALUES ('dl1', 'draft1', 'acc-1000', 123456, 0, 1)`,
        []
      );
    });
    // Original (reversed) + mirror (posted) both count in the report totals: the mirror swaps debit and credit, so each
    // reversed sale adds its amounts to BOTH sides of every account it touched. The BALANCE per account drops by the sale.
    const after = await money<Totals>(stub, 'led-reverse', 'accountTotals', {});
    const b = byCode(before);
    const a = byCode(after);
    const grossSum = victims.reduce((s, v) => s + v.amount, 0);
    expect(a.get('1000')!.debit - b.get('1000')!.debit).toBe(0);
    expect(a.get('1000')!.credit - b.get('1000')!.credit).toBe(grossSum); // cash credited back
    expect(a.get('1000')!.debit - a.get('1000')!.credit).toBe(
      b.get('1000')!.debit - b.get('1000')!.credit - grossSum
    );
    expect(after.rows.reduce((s, r) => s + r.debit, 0)).toBe(
      after.rows.reduce((s, r) => s + r.credit, 0)
    );

    // Daily close counts POSTED only (originals are 'reversed', mirrors 'posted'): still balanced, draft excluded.
    const tb = await money<{ debit: number; credit: number }>(
      stub,
      'led-reverse',
      'trialBalance',
      {}
    );
    expect(tb.debit).toBe(tb.credit);
  });
});
