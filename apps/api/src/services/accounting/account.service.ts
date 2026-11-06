import { prisma, withStore, DbClient } from '@ebda/database';
import type { AccountType, Prisma } from '@prisma/client';
import { COA_TEMPLATE } from './coa-template';
import { postEntry } from './journal.service';
import { storeDb, storeRepo, storeStock, storeWriter } from '../../lib/repo-factory';
import { AppError } from '../../middleware/error-handler';

/**
 * Seed the Egypt-retail Chart of Accounts for a store. Idempotent — existing
 * system accounts (matched by code) are left untouched; only missing rows are
 * inserted. Safe to re-run after partial failures.
 *
 * Accepts an optional Prisma transaction client so callers (e.g. StoreService
 * during store creation) can include the seed inside their own transaction.
 */
export async function seedCoaForStore(
  storeId: string,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const run = async (client: Prisma.TransactionClient): Promise<number> => {
    const existing = await client.account.findMany({
      where: { storeId, isSystem: true },
      select: { code: true },
    });
    const have = new Set(existing.map(a => a.code));

    const toCreate = COA_TEMPLATE.filter(row => !have.has(row.code));
    if (toCreate.length > 0) {
      await client.account.createMany({
        data: toCreate.map(row => ({
          storeId,
          code: row.code,
          nameEn: row.nameEn,
          nameAr: row.nameAr,
          type: row.type as AccountType,
          isSystem: true,
          isActive: true,
        })),
      });
    }

    // Opening balance — runs AFTER COA accounts exist so getSystemAccountIdByCode resolves.
    // Idempotent: postEntry's (source='opening_balance', sourceId=storeId) key catches re-runs.
    await postOpeningBalanceIfNeeded(storeId, client);

    // Return the number of newly-created accounts so callers (e.g. the seed
    // endpoint) can report it. 0 means the store was already fully seeded.
    return toCreate.length;
  };
  if (tx) return run(tx);
  // A store on its Durable Object seeds its chart and posts the opening balance there, in one section (Ruling CF-R7-1).
  const stock = await storeStock(storeId);
  if (stock) {
    const r = await stock.seedCoa({
      accounts: COA_TEMPLATE.map(row => ({
        code: row.code,
        nameEn: row.nameEn,
        nameAr: row.nameAr ?? null,
        type: row.type,
      })),
    });
    return r.created;
  }
  // No caller tx → run in the store's scope. seedCoaForStore is called by
  // StoreService.create (super-admin) and by the accounting-enable
  // toggle path; neither sets app.current_store_id in their outer
  // transaction. Without a store scope, accounts.findMany returns empty (RLS
  // filter), createMany throws WITH CHECK violation.
  return withStore(storeId, run);
}

/**
 * If a store has existing stock value at the moment accounting is turned on,
 * post a one-time opening-balance journal: DR Inventory / CR Owner's Equity.
 * Idempotent via (source='opening_balance', sourceId=storeId) — the partial
 * unique index on journal_entries(store_id, source, source_id) ensures one-only.
 *
 * Skipped when:
 *   - Store has no products with positive (inventory × costPrice)
 *   - Opening balance already posted (the postEntry idempotency check catches re-runs)
 */
async function postOpeningBalanceIfNeeded(
  storeId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  // Sum inventory × costPrice across non-deleted, non-archived products that
  // track inventory and have no variants (parent row contributes directly).
  const productRows = await tx.product.findMany({
    where: {
      storeId,
      deletedAt: null,
      status: { not: 'archived' },
      trackInventory: true,
      hasVariants: false,
      costPrice: { not: null, gt: 0 },
      inventory: { gt: 0 },
    },
    select: { id: true, inventory: true, costPrice: true },
  });

  // Variants contribute their own inventory × costPrice. Per-variant costPrice
  // is used when set; falls back to the parent product's costPrice otherwise
  // (Ebda Batch 1 — per-variant cost not always populated).
  const variantRows = await tx.productVariant.findMany({
    where: {
      product: { storeId, deletedAt: null, status: { not: 'archived' }, trackInventory: true },
      // A disabled variant is not stock (#1103), so it is not inventory value.
      isActive: true,
      inventory: { gt: 0 },
    },
    select: {
      id: true,
      inventory: true,
      costPrice: true,
      product: { select: { costPrice: true } },
    },
  });

  const productValue = productRows.reduce((sum, p) => sum + p.inventory * (p.costPrice ?? 0), 0);
  // Use variant's own costPrice when set; fall back to parent costPrice.
  const variantValue = variantRows.reduce(
    (sum, v) => sum + v.inventory * (v.costPrice ?? v.product.costPrice ?? 0),
    0
  );
  const total = productValue + variantValue;
  if (total <= 0) return;

  const inventoryAccountId = await getSystemAccountIdByCode(storeId, '1200', tx);
  const equityAccountId = await getSystemAccountIdByCode(storeId, '3000', tx);

  await postEntry({
    storeId,
    source: 'opening_balance',
    sourceId: storeId, // one opening-balance entry per store, ever
    memo: 'Opening balance — inventory carried forward',
    memoAr: 'الرصيد الافتتاحي — المخزون المُرحَّل',
    lines: [
      {
        accountId: inventoryAccountId,
        debit: total,
        credit: 0,
        lineMemo: `Opening inventory value (${productRows.length + variantRows.length} SKUs)`,
        refTable: 'stores',
        refId: storeId,
      },
      {
        accountId: equityAccountId,
        debit: 0,
        credit: total,
        lineMemo: 'Equity contra-entry for opening inventory',
        refTable: 'stores',
        refId: storeId,
      },
    ],
    tx,
  });
}

/**
 * Lookup helper used by posting services: resolve an account's id by its code.
 * Throws if missing — callers should never reference a non-seeded code.
 */
export async function getSystemAccountIdByCode(
  storeId: string,
  code: string,
  tx?: DbClient
): Promise<string> {
  // 2026-05-21: when no tx is passed, the proxy prisma falls through to
  // basePrisma which has no app.current_store_id GUC. accounts RLS
  // policy (accounting_foundations migration) requires either the GUC
  // OR app.bypass_rls = 'true', so without the wrap account.findUnique
  // silently returns null → throws "seed COA first" even though the COA
  // exists. Wrap in withStore when standalone; tx callers are
  // assumed to have set up the GUC already.
  const findIt = (client: Prisma.TransactionClient | typeof prisma) =>
    client.account.findUnique({
      where: { storeId_code: { storeId, code } },
      select: { id: true },
    });
  // A store on its Durable Object reads its own chart of accounts. No self-heal there: the cutover import carries the accounts
  // across, so a missing system account is a real fault (the ledger twin answers ACCOUNT_NOT_FOUND the same way).
  if (!tx) {
    const repo = await storeRepo(storeId);
    if (repo.backend === 'do') {
      const hit = await repo.db.account.findFirst({
        where: { storeId, code },
        select: { id: true },
      });
      if (hit) return hit.id;
      throw new Error(`System account ${code} not found for store ${storeId} — seed COA first`);
    }
  }
  const acct = tx ? await findIt(tx) : await withStore(storeId, findIt);
  if (acct) return acct.id;

  // Self-heal chart-of-accounts template drift. A system code that exists in
  // COA_TEMPLATE but is missing for this store — e.g. '1020' (Cash COD) was
  // added to the template AFTER the store was seeded — used to throw here and
  // fail the entire journal post (48× in Sentry for one store). Lazily upsert
  // the single missing system account from the template instead (idempotent +
  // race-safe on the storeId_code unique). Codes NOT in the template still
  // throw — those are genuine caller bugs. Mirrors seedCoaForStore's row shape.
  const tmpl = COA_TEMPLATE.find(row => row.code === code);
  if (!tmpl) {
    throw new Error(`System account ${code} not found for store ${storeId} — seed COA first`);
  }
  const healOne = (client: Prisma.TransactionClient | typeof prisma) =>
    client.account.upsert({
      where: { storeId_code: { storeId, code: tmpl.code } },
      create: {
        storeId,
        code: tmpl.code,
        nameEn: tmpl.nameEn,
        nameAr: tmpl.nameAr,
        type: tmpl.type as AccountType,
        isSystem: true,
        isActive: true,
      },
      update: {},
      select: { id: true },
    });
  const healed = tx ? await healOne(tx) : await withStore(storeId, healOne);
  return healed.id;
}

export interface AccountsTreeNode {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  type: AccountType;
  isSystem: boolean;
  isActive: boolean;
  children: AccountsTreeNode[];
}

export interface AccountsTree {
  assets: AccountsTreeNode[];
  liabilities: AccountsTreeNode[];
  equity: AccountsTreeNode[];
  revenue: AccountsTreeNode[];
  expenses: AccountsTreeNode[];
}

export interface CreateChildAccountInput {
  storeId: string;
  parentId: string;
  code: string; // unique per store, must not start with a system reserved prefix already in use
  nameEn: string;
  nameAr?: string;
}

/**
 * Create a custom (non-system) child account under an existing parent account.
 * Type is inherited from the parent — merchants cannot mix types in a tree.
 * Throws if:
 *   - parent doesn't exist or belongs to a different store
 *   - parent is itself a non-system custom child (we only allow one level of customization)
 *   - code collides with an existing account in this store
 */
export async function createChildAccount(input: CreateChildAccountInput) {
  // Reads and the write follow the store's backend (Ruling NZ-FEAT-1): a Durable Object store keeps its chart there. On Postgres
  // both clients are the `prisma` proxy, so the request transaction and the tenant guard are unchanged.
  const db = await storeDb(input.storeId);
  const parent = await db.account.findFirst({
    where: { id: input.parentId, storeId: input.storeId },
    select: { id: true, type: true, isSystem: true, code: true },
  });
  if (!parent)
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Parent account not found in this store');
  if (!parent.isSystem) {
    throw new AppError(
      409,
      'ACCOUNT_PARENT_NOT_SYSTEM',
      'Custom children are only allowed under system accounts (one-level deep)'
    );
  }
  const collision = await db.account.findFirst({
    where: { storeId: input.storeId, code: input.code },
    select: { id: true },
  });
  if (collision)
    throw new AppError(
      409,
      'ACCOUNT_CODE_EXISTS',
      `Account code ${input.code} already exists in this store`
    );

  const w = await storeWriter(input.storeId);
  return w.account.create({
    data: {
      storeId: input.storeId,
      parentId: input.parentId,
      code: input.code,
      nameEn: input.nameEn,
      nameAr: input.nameAr,
      type: parent.type,
      isSystem: false,
      isActive: true,
    },
  });
}

/**
 * Soft-disable a custom account. System accounts can never be disabled.
 * Disabled accounts remain visible in the COA tree (greyed out in UI) but
 * cannot be used as new journal-line targets.
 */
export async function setAccountActive(storeId: string, accountId: string, isActive: boolean) {
  const acct = await (
    await storeDb(storeId)
  ).account.findFirst({
    where: { id: accountId, storeId },
    select: { isSystem: true },
  });
  if (!acct) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (acct.isSystem)
    throw new AppError(409, 'ACCOUNT_SYSTEM', 'System accounts cannot be disabled');
  const w = await storeWriter(storeId);
  return w.account.update({ where: { id: accountId, storeId }, data: { isActive } });
}

/**
 * Returns the COA grouped by type with parent-child nesting. Roots are the
 * accounts with no parentId; their children are nested via the AccountTree
 * self-relation. Sorted by code ascending within each branch.
 */
export async function listAccountsTree(storeId: string): Promise<AccountsTree> {
  const all = await (
    await storeDb(storeId)
  ).account.findMany({
    where: { storeId },
    orderBy: { code: 'asc' },
  });
  const byParent = new Map<string | null, AccountsTreeNode[]>();
  for (const a of all) {
    const node: AccountsTreeNode = {
      id: a.id,
      code: a.code,
      nameEn: a.nameEn,
      nameAr: a.nameAr,
      type: a.type,
      isSystem: a.isSystem,
      isActive: a.isActive,
      children: [],
    };
    const k = a.parentId;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(node);
  }
  function attach(node: AccountsTreeNode) {
    node.children = byParent.get(node.id) ?? [];
    node.children.forEach(attach);
  }
  const roots = byParent.get(null) ?? [];
  roots.forEach(attach);
  return {
    assets: roots.filter(n => n.type === 'asset'),
    liabilities: roots.filter(n => n.type === 'liability'),
    equity: roots.filter(n => n.type === 'equity'),
    revenue: roots.filter(n => n.type === 'revenue'),
    expenses: roots.filter(n => n.type === 'expense'),
  };
}
