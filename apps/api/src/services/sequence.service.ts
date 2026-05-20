import { prisma } from '@force/database';

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
 */
export async function nextSequence(storeId: string, kind: SequenceKind): Promise<string> {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`Unknown sequence kind: ${kind}`);

  const year = new Date().getUTCFullYear();

  // INSERT initializes counter at 2 (we're returning value 1).
  // ON CONFLICT path increments existing counter by 1 and returns (next - 1).
  // schema-qualify the table so pgbouncer transaction-mode connections that
  // don't inherit search_path=public still resolve the relation correctly.
  const row = await prisma.$queryRaw<{ next: number }[]>`
    INSERT INTO public.sequences (store_id, kind, next, updated_at)
    VALUES (${storeId}, ${kind}, 2, now())
    ON CONFLICT (store_id, kind)
    DO UPDATE SET next = public.sequences.next + 1, updated_at = now()
    RETURNING next - 1 AS next
  `;
  const n = Number(row[0].next);
  return `${prefix}-${year}-${String(n).padStart(6, '0')}`;
}
