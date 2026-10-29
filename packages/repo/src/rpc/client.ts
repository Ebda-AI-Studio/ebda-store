import { decodeRpc } from './codec';
import { rethrow, type DoQuery, type DoQueryResult, type ReadOp, READ_OPS } from './reads';
import { WRITE_OPS, type DoMutation, type WriteOp } from './writes';

/** How the Worker reaches one store's DO: the stub's `query` RPC (or, in tests, an in-process stand-in). */
export type DoTransport = (queries: DoQuery[]) => Promise<DoQueryResult>;
/** How the Worker ships a write batch: the stub's `mutate` RPC (one atomic transaction in the DO). */
export type DoMutateTransport = (m: DoMutation) => Promise<DoQueryResult>;

const isWriteOp = (op: string): boolean => (WRITE_OPS as readonly string[]).includes(op);

/**
 * A lazy query, like Prisma's PrismaPromise: nothing is sent until awaited, so `$transaction([a, b])` can ship
 * both in ONE round trip (and one consistent snapshot).
 */
class Pending<T> implements PromiseLike<T> {
  constructor(
    readonly query: DoQuery,
    private readonly send: DoTransport,
    private readonly mutate?: DoMutateTransport
  ) {}
  then<A = T, B = never>(
    ok?: ((v: T) => A | PromiseLike<A>) | null,
    err?: ((e: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return runAll<T>([this.query], this.send, this.mutate)
      .then(r => r[0] as T)
      .then(ok, err);
  }
}

async function runAll<T>(
  queries: DoQuery[],
  send: DoTransport,
  mutate?: DoMutateTransport,
  key?: string
): Promise<T[]> {
  // Any write in the batch routes the WHOLE batch to the atomic mutate RPC (reads in it see the writes before them).
  const writes = queries.some(q => isWriteOp(q.op));
  if (writes && !mutate) throw new Error('DO client: writes are not enabled on this client');
  const r = writes ? await mutate!({ key, ops: queries }) : await send(queries);
  if (!r.ok) rethrow(r);
  return decodeRpc<T[]>(r.json);
}

const CLIENT_MARK = Symbol('doClient');

/**
 * A Prisma-shaped client for one store's Durable Object. Same method names and result shapes as the Prisma
 * client for `READ_OPS`; writes exist only when `mutate` is given (PR D1: the non-money catalogue/content models; the DO re-checks the allow-list). Without it a write is refused here, before a byte leaves the Worker.
 */
export function createDoClient(send: DoTransport, mutate?: DoMutateTransport) {
  const delegate = (model: string) =>
    Object.fromEntries(
      [...READ_OPS, ...(mutate ? WRITE_OPS : [])].map(op => [
        op,
        (args?: Record<string, unknown>) =>
          new Pending({ model, op: op as ReadOp | WriteOp, args } as DoQuery, send, mutate),
      ])
    );
  return new Proxy({ [CLIENT_MARK]: true } as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop === '$transaction')
        return async (arg: unknown, opts?: { idempotencyKey?: string }) => {
          if (!Array.isArray(arg) || !arg.every(a => a instanceof Pending))
            throw new Error(
              'DO client: $transaction takes an array of queries (interactive transactions are not on this path)'
            );
          return runAll(
            (arg as Pending<unknown>[]).map(p => p.query),
            send,
            mutate,
            opts?.idempotencyKey
          );
        };
      if (prop[0] === '$' || prop[0] === '_')
        throw new Error(`DO client: ${prop} is not available on the StoreDO read path`);
      return delegate(prop[0].toUpperCase() + prop.slice(1));
    },
  }) as unknown as Record<
    string,
    Record<ReadOp | WriteOp, (args?: Record<string, unknown>) => PromiseLike<any>>
  > & {
    $transaction(
      ops: PromiseLike<unknown>[],
      opts?: { idempotencyKey?: string }
    ): Promise<unknown[]>;
  };
}
