/**
 * The Postgres session settings (GUCs) that RLS policies read, and the
 * statements that set them for one transaction.
 *
 * Shared by `runInTenantContext`, the proxy's `$transaction` inheritance and
 * `withMoneyTx` so all three set the SAME settings the SAME way.
 */

export interface TenantGucs {
  storeId?: string;
  userId?: string;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `SET LOCAL` statements for the given settings, in a fixed order. */
export function gucStatements(gucs: TenantGucs): string[] {
  const out: string[] = [];
  if (gucs.storeId) {
    out.push(`SET LOCAL app.current_store_id = '${gucs.storeId.replace(/'/g, "''")}'`);
  }
  if (gucs.userId) {
    out.push(`SET LOCAL app.current_user_id = '${gucs.userId.replace(/'/g, "''")}'`);
  }
  return out;
}

/** Run the `SET LOCAL`s on an open interactive transaction. */
export async function applyGucs(
  tx: { $executeRawUnsafe: (sql: string) => Promise<unknown> },
  gucs: TenantGucs
): Promise<void> {
  for (const sql of gucStatements(gucs)) await tx.$executeRawUnsafe(sql);
}

/**
 * Set the RLS settings on a transaction the caller opened itself
 * (`withMoneyTx`, `prisma.$transaction`) when there is no ambient context for
 * it to inherit — e.g. the public checkout. Validates like
 * `runInTenantContext`.
 */
export async function setTenantGucs(
  tx: { $executeRawUnsafe: (sql: string) => Promise<unknown> },
  gucs: TenantGucs
): Promise<void> {
  if (gucs.storeId !== undefined && !UUID_RE.test(gucs.storeId)) {
    throw new Error('Invalid store ID format');
  }
  if (gucs.userId !== undefined && !UUID_RE.test(gucs.userId)) {
    throw new Error('Invalid user ID format');
  }
  await applyGucs(tx, gucs);
}
