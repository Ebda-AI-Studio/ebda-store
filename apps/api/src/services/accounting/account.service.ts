import { prisma } from '@force/database';
import type { AccountType, Prisma } from '@prisma/client';
import { COA_TEMPLATE } from './coa-template';
import { postEntry } from './journal.service';

/**
 * Seed the Kuwait-retail Chart of Accounts for a store. Idempotent — existing
 * system accounts (matched by code) are left untouched; only missing rows are
 * inserted. Safe to re-run after partial failures.
 *
 * Accepts an optional Prisma transaction client so callers (e.g. StoreService
 * during store creation) can include the seed inside their own transaction.
 */
export async function seedCoaForStore(
  storeId: string,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const run = async (client: Prisma.TransactionClient) => {
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
  };
  if (tx) return run(tx);
  return prisma.$transaction(run);
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
  // (FWB Batch 1 — per-variant cost not always populated).
  const variantRows = await tx.productVariant.findMany({
    where: {
      product: { storeId, deletedAt: null, status: { not: 'archived' }, trackInventory: true },
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
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string> {
  const acct = await tx.account.findUnique({
    where: { storeId_code: { storeId, code } },
    select: { id: true },
  });
  if (!acct) {
    throw new Error(`System account ${code} not found for store ${storeId} — seed COA first`);
  }
  return acct.id;
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

/**
 * Returns the COA grouped by type with parent-child nesting. Roots are the
 * accounts with no parentId; their children are nested via the AccountTree
 * self-relation. Sorted by code ascending within each branch.
 */
export async function listAccountsTree(storeId: string): Promise<AccountsTree> {
  const all = await prisma.account.findMany({
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
