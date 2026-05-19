import { prisma } from '@force/database';
import type { AccountType, Prisma } from '@prisma/client';
import { COA_TEMPLATE } from './coa-template';

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
    if (toCreate.length === 0) return;

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
  };
  if (tx) return run(tx);
  return prisma.$transaction(run);
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
