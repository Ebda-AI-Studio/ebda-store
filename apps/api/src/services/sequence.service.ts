import type { Prisma } from '@prisma/client';
import { withRlsBypass } from '@force/database';

const PREFIX = {
  journal: 'JE',
  po: 'PO',
  adjustment: 'ADJ',
  expense: 'EXP',
} as const;

export type SequenceKind = keyof typeof PREFIX;

/**
 * Atomically returns the next formatted identifier for a (storeId, kind) pair.
 * Uses INSERT … ON CONFLICT DO UPDATE … RETURNING to claim the next value in
 * a single statement — two concurrent calls cannot return the same number
 * because Postgres row-locks the upserted row inside the same statement.
 *
 * Format: `<PREFIX>-<YYYY>-<NNNNNN>` (e.g. JE-2026-000123).
 *
 * @param tx Optional existing transaction client. When provided, the sequence
 *   increment runs on the SAME connection as the caller, avoiding a nested
 *   withRlsBypass call that would require a second pool connection. Pass this
 *   when nextSequence is called from within a withRlsBypass or $transaction
 *   callback to prevent pool-exhaustion deadlock under concurrent fan-out
 *   (see journal.service.ts postEntry for the concrete case fixed).
 */
export async function nextSequence(
  storeId: string,
  kind: SequenceKind,
  tx?: Prisma.TransactionClient
): Promise<string> {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`Unknown sequence kind: ${kind}`);

  const year = new Date().getUTCFullYear();

  // INSERT initializes counter at 2 (we're returning value 1).
  // ON CONFLICT path increments existing counter by 1 and returns (next - 1).
  // schema-qualify the table so pgbouncer transaction-mode connections that
  // don't inherit search_path=public still resolve the relation correctly.
  //
  // sequences table has RLS enabled (accounting_foundations migration).
  // Wrap in withRlsBypass for Inngest/cron callers that have no tenant
  // context. Request-handler callers already run inside a tenant tx
  // with app.current_store_id set; nesting withRlsBypass inside a
  // tenant context simply overrides bypass=true for our transaction
  // which is fine — sequence values are storeId-scoped via the
  // composite primary key, so cross-tenant leak isn't possible.
  //
  // When a transaction client is supplied, run the upsert on that connection
  // directly — no new pool connection acquired, no deadlock risk under load.
  const execQuery = async (client: Prisma.TransactionClient) =>
    client.$queryRaw<{ next: number }[]>`
      INSERT INTO public.sequences (store_id, kind, next, updated_at)
      VALUES (${storeId}, ${kind}, 2, now())
      ON CONFLICT (store_id, kind)
      DO UPDATE SET next = public.sequences.next + 1, updated_at = now()
      RETURNING next - 1 AS next
    `;

  const row = tx
    ? await execQuery(tx)
    : await withRlsBypass(innerTx => execQuery(innerTx as unknown as Prisma.TransactionClient));

  const n = Number(row[0].next);
  return `${prefix}-${year}-${String(n).padStart(6, '0')}`;
}
