import { decodeRpc } from './codec';
import { rethrow, type DoQuery, type DoQueryResult, type ReadOp, READ_OPS } from './reads';

/** How the Worker reaches one store's DO: the stub's `query` RPC (or, in tests, an in-process stand-in). */
export type DoTransport = (queries: DoQuery[]) => Promise<DoQueryResult>;

/**
 * A lazy query, like Prisma's PrismaPromise: nothing is sent until awaited, so `$transaction([a, b])` can ship
 * both in ONE round trip (and one consistent snapshot).
 */
class Pending<T> implements PromiseLike<T> {
  constructor(
    readonly query: DoQuery,
    private readonly send: DoTransport
  ) {}
  then<A = T, B = never>(
    ok?: ((v: T) => A | PromiseLike<A>) | null,
    err?: ((e: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return runAll<T>([this.query], this.send)
      .then(r => r[0] as T)
      .then(ok, err);
  }
}

async function runAll<T>(queries: DoQuery[], send: DoTransport): Promise<T[]> {
  const r = await send(queries);
  if (!r.ok) rethrow(r);
  return decodeRpc<T[]>(r.json);
}

const CLIENT_MARK = Symbol('doClient');

/**
 * A Prisma-shaped READ client for one store's Durable Object. Same method names and result shapes as the Prisma
 * client for `READ_OPS`; any write is refused here, before a byte leaves the Worker (PR D moves writes and money).
 */
export function createDoClient(send: DoTransport) {
  const delegate = (model: string) =>
    Object.fromEntries(
      READ_OPS.map(op => [
        op,
        (args?: Record<string, unknown>) => new Pending({ model, op: op as ReadOp, args }, send),
      ])
    );
  return new Proxy({ [CLIENT_MARK]: true } as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop === '$transaction')
        return async (arg: unknown) => {
          if (!Array.isArray(arg) || !arg.every(a => a instanceof Pending))
            throw new Error(
              'DO client: $transaction takes an array of reads (interactive and write transactions are not on this path)'
            );
          return runAll(
            (arg as Pending<unknown>[]).map(p => p.query),
            send
          );
        };
      if (prop[0] === '$' || prop[0] === '_')
        throw new Error(`DO client: ${prop} is not available on the StoreDO read path`);
      return delegate(prop[0].toUpperCase() + prop.slice(1));
    },
  }) as unknown as Record<
    string,
    Record<ReadOp, (args?: Record<string, unknown>) => PromiseLike<any>>
  > & {
    $transaction(reads: PromiseLike<unknown>[]): Promise<unknown[]>;
  };
}
