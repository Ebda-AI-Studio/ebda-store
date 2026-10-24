import { WriteEngine, mapDbError } from './writes';
import type { Meta, SqlRunner } from './types';

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
export function createPrismaLite(meta: Meta, sql: SqlRunner) {
  const engine = new WriteEngine(meta, sql);
  const byDelegate = new Map(
    Object.keys(meta.models).map(m => [m[0].toLowerCase() + m.slice(1), m])
  );
  const lazy = <T>(fn: () => T) => new LazyQuery(fn);
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
            where: expandUnique(meta, model, args.where as Record<string, unknown>),
            take: 1,
          })[0] ?? null
      ),
    findUniqueOrThrow: (args: Record<string, unknown>) =>
      lazy(() => {
        const r = engine.findMany(model, {
          ...args,
          where: expandUnique(meta, model, args.where as Record<string, unknown>),
          take: 1,
        })[0];
        if (!r) throw notFound(model);
        return r;
      }),
    count: (args?: Record<string, unknown>) => lazy(() => engine.count(model, args)),
    create: (args: Record<string, unknown>) => lazy(() => engine.create(model, args)),
    createMany: (args: Record<string, unknown>) => lazy(() => engine.createMany(model, args)),
    update: (args: Record<string, unknown>) =>
      lazy(() =>
        engine.update(model, {
          ...args,
          where: expandUnique(meta, model, args.where as Record<string, unknown>),
        })
      ),
    updateMany: (args: Record<string, unknown>) => lazy(() => engine.updateMany(model, args)),
    upsert: (args: Record<string, unknown>) =>
      lazy(() =>
        engine.upsert(model, {
          ...args,
          where: expandUnique(meta, model, args.where as Record<string, unknown>),
        })
      ),
    delete: (args: Record<string, unknown>) =>
      lazy(() =>
        engine.delete(model, {
          ...args,
          where: expandUnique(meta, model, args.where as Record<string, unknown>),
        })
      ),
    deleteMany: (args?: Record<string, unknown>) => lazy(() => engine.deleteMany(model, args)),
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
    if (!sql.transaction) return body() as Promise<T>;
    return sql.transaction(body) as Promise<T>;
  }

  const client: any = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === '$transaction') return $transaction;
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
  const e = new Error(`No ${model} found`);
  (e as { code?: string }).code = 'P2025';
  return e;
}

/**
 * `{ storeId_slug: { storeId, slug } }` -> `{ storeId, slug }` (Prisma's compound-unique selector), and, like
 * Prisma, REFUSES a selector that does not name a complete unique tuple: a missing or undefined field must
 * never degrade into "first row" (a cross-record / cross-tenant read).
 */
export function expandUnique(
  meta: Meta,
  model: string,
  where: Record<string, unknown>
): Record<string, unknown> {
  if (!where || typeof where !== 'object') throw new Error('prisma-lite: findUnique needs a where');
  const out: Record<string, unknown> = {};
  const uniques = meta.models[model].uniques.concat([meta.models[model].pk]);
  for (const [k, v] of Object.entries(where)) {
    const hit = uniques.find(u => u.length > 1 && u.join('_') === k);
    if (hit) {
      if (!v || typeof v !== 'object') throw new Error(`prisma-lite: ${k} needs an object`);
      Object.assign(out, v);
    } else out[k] = v;
  }
  const complete = uniques.some(
    u => u.length > 0 && u.every(f => out[f] !== undefined && out[f] !== null)
  );
  if (!complete)
    throw new Error(
      `prisma-lite: findUnique on ${model} needs every field of a unique key, non-null`
    );
  return out;
}
