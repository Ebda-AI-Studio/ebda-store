/**
 * INFRA-CF-1 R3 (Ruling WALLET-GL-1): every wallet movement journaled on 2150 (the DO half of `postWalletMovementJournal`) give
 * the same answer and leave the same rows on Postgres and on the DO. Each test is a SCENARIO driving the real service; it runs
 * once on Postgres (unchanged code) and once with the DO money client over the real DO schema on SQLite (real wire codec,
 * `answerMoneyOp`, `runMoneyOp`). Each backend gets its own identical world (mirrored into SQLite); the scrubbed traces
 * (return values or error, then the ledger / order / stock / price rows) must be equal. Trial balance parity is asserted
 * per account code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { featureService } from '../../apps/api/src/services/feature.service';
import {
  makeMoneyClient,
  storeDb,
  storeMoney,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { seedCoaForStore } from '../../apps/api/src/services/accounting/account.service';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { WalletService } from '../../apps/api/src/services/wallet.service';
import { hasDb } from '../helpers/bundle-fixtures';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', {
    storeId: STORE,
  }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return {
    storeId: STORE,
    backend: 'do' as const,
    db: c as StoreReads,
    writer: c as StoreWrites,
    money,
  };
}
const pgRepo = () => ({
  storeId: STORE,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrub(v: unknown, names: Record<string, string>): unknown {
  let text = JSON.stringify(canon(v)) ?? 'null';
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(
    text
      .replace(UUID, '<id>')
      .replace(/(JE|ORD|PAID)-[A-Z0-9-]+/g, '<no>')
      .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
  );
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        status: e.statusCode,
        code: e.code,
        message: e.code ? undefined : String(e.message).slice(0, 120),
      },
    })
  );

let n = 0;
/** A store customer on Postgres (a customer `User`) and on the DO (a `customers` row with the same id). */
async function customer(mirror: boolean) {
  const k = `${sfx}w${++n}`;
  const u = await prisma.user.create({
    data: {
      email: `wal-${k}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'W',
      lastName: 'C',
      role: 'customer',
      storeId: STORE,
      status: 'active',
      emailVerified: true,
    },
  });
  if (mirror)
    sqlite
      .prepare('INSERT INTO customers (id, store_id, first_name, last_name) VALUES (?, ?, ?, ?)')
      .run(u.id, STORE, 'W', 'C');
  return { id: u.id, names: { [u.id]: 'customer' } };
}

/** Per-account debit / credit totals of the store's ledger, through whichever backend is current. */
async function ledger() {
  const db = (await storeDb(STORE)) as never as {
    journalEntry: {
      findMany(
        a: unknown
      ): Promise<Array<{ status: string; source: string; sourceId: string | null }>>;
    };
    journalLine: {
      findMany(a: unknown): Promise<Array<{ debit: number; credit: number; accountId: string }>>;
    };
    account: { findMany(a: unknown): Promise<Array<{ id: string; code: string }>> };
  };
  const accounts = await db.account.findMany({
    where: { storeId: STORE },
    select: { id: true, code: true },
  });
  const code = new Map(accounts.map(a => [a.id, a.code]));
  const lines = await db.journalLine.findMany({
    where: { entry: { storeId: STORE } },
    select: { debit: true, credit: true, accountId: true },
  });
  const entries = await db.journalEntry.findMany({
    where: { storeId: STORE },
    select: { status: true, source: true, sourceId: true },
  });
  const by: Record<string, { debit: number; credit: number }> = {};
  for (const l of lines) {
    const c = code.get(l.accountId) ?? '?';
    by[c] = { debit: (by[c]?.debit ?? 0) + l.debit, credit: (by[c]?.credit ?? 0) + l.credit };
  }
  return {
    trial: Object.fromEntries(Object.entries(by).sort(([a], [b]) => a.localeCompare(b))),
    balanced:
      Object.values(by).reduce((s, x) => s + x.debit, 0) ===
      Object.values(by).reduce((s, x) => s + x.credit, 0),
    entries: entries.length,
  };
}
async function walletState(customerId: string) {
  const db = (await storeDb(STORE)) as never as {
    customerWallet: { findFirst(a: unknown): Promise<{ balance: number } | null> };
    walletTransaction: {
      findMany(a: unknown): Promise<Array<{ amount: number; type: string; balanceAfter: number }>>;
    };
  };
  return {
    balance: (await db.customerWallet.findFirst({ where: { storeId: STORE, customerId } }))
      ?.balance,
    rows: await db.walletTransaction.findMany({
      where: { storeId: STORE, customerId },
      orderBy: { createdAt: 'asc' },
      select: { amount: true, type: true, balanceAfter: true },
    }),
    ledger: await ledger(),
  };
}
async function parity(
  act: (customerId: string) => Promise<unknown>,
  { accounting = true }: { accounting?: boolean } = {}
) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    // each backend runs against a store whose accounting flag is set the same way and whose ledger is empty
    await prisma.store.update({ where: { id: STORE }, data: { accountingEnabled: accounting } });
    sqlite
      .prepare('INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES (?, ?)')
      .run(STORE, accounting ? 1 : 0);
    const c = await customer(mirror);
    const before = await on(ledger);
    const out = await settle(() => on(() => act(c.id)));
    const state = await on(() => walletState(c.id));
    // the ledger is the store's, shared by the scenarios: report only what THIS scenario posted
    const trial: Record<string, { debit: number; credit: number }> = {};
    for (const [code, v] of Object.entries(state.ledger.trial)) {
      const b = before.trial[code] ?? { debit: 0, credit: 0 };
      if (v.debit !== b.debit || v.credit !== b.credit)
        trial[code] = { debit: v.debit - b.debit, credit: v.credit - b.credit };
    }
    state.ledger = { ...state.ledger, trial, entries: state.ledger.entries - before.entries };
    return scrub({ out, state }, c.names);
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `r3w-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'R',
      lastName: 'W',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  STORE = (
    await prisma.store.create({
      data: { name: 'R3Wallet', slug: `r3w-${sfx}`, ownerId: owner.id, status: 'active' },
    })
  ).id;
  await seedCoaForStore(STORE);
  const accounts = await prisma.account.findMany({ where: { storeId: STORE } });
  insertSqlite(sqlite, 'Account', accounts as never);
});
beforeEach(() => {
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(true);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

const adj = (customerId: string, amount: number, requestKey: string) =>
  WalletService.adminAdjust({
    storeId: STORE,
    customerId,
    amount,
    note: 'n',
    actorId: ownerId,
    requestKey,
  });

describe.skipIf(!hasDb)(
  'wallet movements and their GL half on Postgres vs the DO (WALLET-GL-1)',
  () => {
    it('goodwill credit, admin reversal and a forfeit land on 2150 / 5950 / 4100 the same way, 2150 equals the balance', async () => {
      const t = await parity(async c => {
        await adj(c, 5_000, 'a');
        await adj(c, -1_500, 'b');
        await WalletService.applyEntry({
          storeId: STORE,
          customerId: c,
          amount: -500,
          type: 'expire',
          idempotencyKey: 'exp-1',
          note: 'expired',
        });
        return 'done';
      });
      expect(t.state.balance).toBe(3_000);
      expect(t.state.ledger.balanced).toBe(true);
      expect(t.state.ledger.trial['2150']).toEqual({ debit: 2_000, credit: 5_000 });
      expect(t.state.ledger.trial['5950']).toEqual({ debit: 5_000, credit: 1_500 });
      expect(t.state.ledger.trial['4100']).toEqual({ debit: 0, credit: 500 });
    });

    it('a replay moves no money and posts no second entry', async () => {
      const t = await parity(async c => {
        await adj(c, 2_000, 'r');
        const again = await adj(c, 2_000, 'r');
        return { replayed: again.replayed, balance: again.balance };
      });
      expect(t.out.ok).toEqual({ replayed: true, balance: 2_000 });
      expect(t.state.ledger.entries).toBe(1);
    });

    it('a debit below zero is refused on both, nothing is journaled', async () => {
      const t = await parity(async c => {
        await adj(c, 1_000, 'p');
        return adj(c, -5_000, 'q');
      });
      expect(t.out.err.code).toBe('INSUFFICIENT_WALLET_BALANCE');
      expect(t.state.balance).toBe(1_000);
    });

    it('with accounting off the wallet moves and the ledger stays empty', async () => {
      const t = await parity(async c => (await adj(c, 700, 'off')).balance, { accounting: false });
      expect(t.state.balance).toBe(700);
      expect(t.state.ledger.entries).toBe(0);
    });

    it('Ruling WALLET-DO-TX-1: a DO wallet credit inside a Postgres transaction is refused, so a rollback leaves no credit and the retry cannot double it', async () => {
      const c = await customer(true);
      // the return-completion shape: a tenant transaction, a wallet credit, then the transaction fails
      const failing = () =>
        onDo(() =>
          runInTenantContext(STORE, async () => {
            await WalletService.applyEntry({
              storeId: STORE,
              customerId: c.id,
              amount: 4_000,
              type: 'refund_credit',
              idempotencyKey: 'return-credit:tx-1',
            });
            throw new Error('postgres transaction fails after the wallet write');
          })
        );
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(failing()).rejects.toMatchObject({ code: 'WALLET_IN_TRANSACTION_NOT_ON_DO' });
      const after = await onDo(() => walletState(c.id));
      expect(after.balance).toBeUndefined(); // no wallet row, no credit, after two attempts
      expect(after.rows).toEqual([]);
      // a caller-supplied client is the same thing
      await expect(
        onDo(() =>
          WalletService.applyEntry(
            {
              storeId: STORE,
              customerId: c.id,
              amount: 1,
              type: 'credit',
              idempotencyKey: 'x-client',
            },
            prisma as never
          )
        )
      ).rejects.toMatchObject({ code: 'WALLET_IN_TRANSACTION_NOT_ON_DO' });
      // outside a transaction the same credit applies once, and its retry replays
      expect((await onDo(() => adj(c.id, 4_000, 'ok'))).replayed).toBe(false);
      expect((await onDo(() => adj(c.id, 4_000, 'ok'))).replayed).toBe(true);
      expect((await onDo(() => walletState(c.id))).balance).toBe(4_000);
    });
  }
);
