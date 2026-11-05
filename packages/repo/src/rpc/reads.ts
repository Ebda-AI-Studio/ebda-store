import { Prisma } from '@prisma/client';
import { decodeRpc, encodeRpc } from './codec';

/** The read operations a StoreDO answers over RPC (writes and stock have their own RPCs, PR D1 / D2a). */
export const READ_OPS = [
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  // PR D2b (Ruling CF-MONEY-1): reporting and money reads. prisma-lite's engine answers both; the contract test compares them
  // with Postgres (`tests/integration/repo-factory-aggregate-contract.test.ts`).
  'aggregate',
  'groupBy',
] as const;
export type ReadOp = (typeof READ_OPS)[number];

export interface DoQuery {
  /** Prisma model name, e.g. `Product` (the delegate is its lower-camel form). */
  model: string;
  op: ReadOp;
  args?: Record<string, unknown>;
}

export type DoQueryResult =
  | { ok: true; json: string }
  | { ok: false; code: string; message: string; status?: number; json?: string };

const isOp = (op: unknown): op is ReadOp => (READ_OPS as readonly string[]).includes(op as string);
const delegateOf = (model: string) => model[0].toLowerCase() + model.slice(1);

/**
 * Run read queries against a prisma-lite client, in order, and encode the results. An unknown model or op, a
 * malformed argument and a not-found-or-throw all come back as `{ok:false}` (never an exception across the RPC edge).
 */
export async function runReads(
  lite: Record<string, unknown>,
  queries: readonly DoQuery[]
): Promise<DoQueryResult> {
  try {
    const out: unknown[] = [];
    for (const q of queries) {
      if (!isOp(q.op)) return { ok: false, code: 'OP_NOT_ALLOWED', message: `op ${String(q.op)}` };
      if (typeof q.model !== 'string' || !/^[A-Z][A-Za-z0-9]*$/.test(q.model))
        return { ok: false, code: 'BAD_MODEL', message: 'model' };
      const d = lite[delegateOf(q.model)] as Record<string, (a?: unknown) => PromiseLike<unknown>>;
      out.push(await d[q.op](q.args));
    }
    return { ok: true, json: encodeRpc(out) };
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; meta?: unknown };
    return {
      ok: false,
      code: typeof err.code === 'string' ? err.code : 'PRISMA_LITE',
      message: typeof err.message === 'string' ? err.message : 'query failed',
      json: err.meta === undefined ? undefined : encodeRpc(err.meta),
    };
  }
}

/** Re-raise a failed DO result as the error Prisma would have thrown (P-codes keep their class). */
export function rethrow(r: Extract<DoQueryResult, { ok: false }>): never {
  if (/^P\d{4}$/.test(r.code))
    throw new Prisma.PrismaClientKnownRequestError(r.message, {
      code: r.code,
      clientVersion: Prisma.prismaVersion.client,
      meta: r.json ? decodeRpc<Record<string, unknown>>(r.json) : undefined,
    });
  throw new Error(r.message);
}

export { decodeRpc };
