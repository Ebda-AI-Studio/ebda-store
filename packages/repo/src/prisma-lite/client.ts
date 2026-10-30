import { WriteEngine, mapDbError, knownError } from './writes';
import type { Meta, SqlRunner, WriteGuard } from './types';
import { expandUnique } from './unique';

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Lazy like Prisma's PrismaPromise: nothing runs until awaited, so `$transaction([a, b])` can order them. */
class LazyQuery<T> implements PromiseLike<T> {
  private p?: Promise<T>;
  constructor(private readonly run: () => T) {}
  exec(): Promise<T> {
    return (this.p ??= new Promise<T>((resolve, reject) => {
      try {
        resolve(this.run());
      } catch (e) {
        reject(mapDbError(e));
      }
    }));
  }
  then<A = T, B = never>(
    ok?: ((v: T) => A | PromiseLike<A>) | null,
    err?: ((e: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return this.exec().then(ok, err);
  }
  catch<B = never>(err?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.exec().catch(err);
  }
  finally(f?: (() => void) | null): Promise<T> {
    return this.exec().finally(f);
  }
}

/**
 * A Prisma-shaped client over the StoreDO's SQLite (Ruling INFRA-CF-4). Everything is synchronous underneath; the
 * promises resolve immediately, so a Durable Object cannot interleave another request between two awaited
 * queries of one handler. `$transaction` maps to the runner's transaction (DO: `ctx.storage.transaction`).
 */
export function createPrismaLite(
  meta: Meta,
  sql: SqlRunner,
  db: 'store-do' | 'd1' = 'store-do',
  opts: { storeId?: string; unscoped?: boolean; guard?: WriteGuard } = {}
) {
  // No RLS inside a DO: a client that is not told which store it serves would let a write carry any store id.
  if (db === 'store-do' && opts.storeId === undefined && opts.unscoped !== true)
    throw new Error(
      'prisma-lite: a StoreDO client needs { storeId } (or { unscoped: true } for tools and tests)'
    );
  // only the models of THIS database get a delegate (the StoreDO has no D1 tables)
  const scoped: Meta = {
    ...meta,
    models: Object.fromEntries(Object.entries(meta.models).filter(([, m]) => m.db === db)),
  };
  const engine = new WriteEngine(scoped, sql, { storeId: opts.storeId, guard: opts.guard });
  const byDelegate = new Map(
    Object.keys(scoped.models).map(m => [m[0].toLowerCase() + m.slice(1), m])
  );
  const lazy = <T>(fn: () => T) => new LazyQuery(fn);
  // A write (create with nested creates, update with nested writes, deleteMany, ...) is ONE atomic unit, like Prisma:
  // a failure midway must not leave the earlier statements applied. Inside `$transaction` the runner joins the open one.
  const atomic = <T>(fn: () => T): Promise<T> =>
    sql.transactionSync
      ? Promise.resolve().then(() => sql.transactionSync!(fn))
      : sql.transaction
        ? sql.transaction(async () => fn())
        : Promise.reject(noTransaction());
  const write = <T>(fn: () => T) => lazy(() => atomic(fn));
  const delegate = (model: string) => ({
    findMany: (args?: Record<string, unknown>) => lazy(() => engine.findMany(model, args)),
    findFirst: (args?: Record<string, unknown>) =>
      lazy(() => engine.findMany(model, { ...args, take: 1 })[0] ?? null),
    findFirstOrThrow: (args?: Record<string, unknown>) =>
      lazy(() => {
        const r = engine.findMany(model, { ...args, take: 1 })[0];
        if (!r) throw notFound(model);
        return r;
      }),
    findUnique: (args: Record<string, unknown>) =>
      lazy(
        () =>
          engine.findMany(model, {
            ...args,
            where: expandUnique(scoped, model, args.where as Record<string, unknown>),
            take: 1,
          })[0] ?? null
      ),
    findUniqueOrThrow: (args: Record<string, unknown>) =>
      lazy(() => {
        const r = engine.findMany(model, {
          ...args,
          where: expandUnique(scoped, model, args.where as Record<string, unknown>),
          take: 1,
        })[0];
        if (!r) throw notFound(model);
        return r;
      }),
    count: (args?: Record<string, unknown>) => lazy(() => engine.count(model, args)),
    create: (args: Record<string, unknown>) => write(() => engine.create(model, args)),
    createMany: (args: Record<string, unknown>) => write(() => engine.createMany(model, args)),
    update: (args: Record<string, unknown>) =>
      write(() =>
        engine.update(model, {
          ...args,
          where: expandUnique(scoped, model, args.where as Record<string, unknown>),
        })
      ),
    updateMany: (args: Record<string, unknown>) => write(() => engine.updateMany(model, args)),
    upsert: (args: Record<string, unknown>) =>
      write(() =>
        engine.upsert(model, {
          ...args,
          where: expandUnique(scoped, model, args.where as Record<string, unknown>),
        })
      ),
    delete: (args: Record<string, unknown>) =>
      write(() =>
        engine.delete(model, {
          ...args,
          where: expandUnique(scoped, model, args.where as Record<string, unknown>),
        })
      ),
    deleteMany: (args?: Record<string, unknown>) => write(() => engine.deleteMany(model, args)),
    aggregate: (args: Record<string, unknown>) => lazy(() => engine.aggregate(model, args)),
    groupBy: (args: Record<string, unknown>) => lazy(() => engine.groupBy(model, args)),
  });

  async function $transaction<T>(
    arg: ((tx: unknown) => Promise<T>) | PromiseLike<unknown>[],
    _opts?: unknown
  ): Promise<T | unknown[]> {
    const body = async () => {
      if (Array.isArray(arg)) {
        const out: unknown[] = [];
        for (const q of arg) out.push(await q); // lazy queries run now, in order, inside the transaction
        return out;
      }
      return arg(client);
    };
    if (!sql.transaction) throw noTransaction(); // never run a $transaction body without a real transaction
    return sql.transaction(body) as Promise<T>;
  }

  const client: any = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === '$transaction') return $transaction;
        // the same database and store, with the RPC write guard on (Ruling CF-R7-4)
        if (prop === '$guarded')
          return (guard: WriteGuard) => createPrismaLite(meta, sql, db, { ...opts, guard });
        if (prop === '$connect' || prop === '$disconnect') return async () => undefined;
        if (prop === 'then') return undefined; // never look like a thenable
        const model = own(Object.fromEntries(byDelegate), prop) ? byDelegate.get(prop) : undefined;
        if (!model) throw new Error(`prisma-lite: no model delegate "${prop}" in this database`);
        return delegate(model);
      },
    }
  );
  return client as Record<string, ReturnType<typeof delegate>> & {
    $transaction: typeof $transaction;
  };
}

function notFound(model: string): Error {
  // a real PrismaClientKnownRequestError: the API's error handler checks `instanceof` to answer 404, not 500
  return knownError('P2025', `No ${model} found`, {
    modelName: model,
    cause: 'Expected a record, found none.',
  });
}

function noTransaction(): Error {
  return new Error(
    'prisma-lite: the SqlRunner has no transaction(); writes and $transaction need one (DO: ctx.storage.transaction)'
  );
}

export { expandUnique };
