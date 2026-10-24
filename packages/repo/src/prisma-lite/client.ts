import { Engine } from './engine';
import type { Meta, SqlRunner } from './types';

/**
 * A Prisma-shaped READ client over the StoreDO's SQLite (spike for Ruling CF-REPO-1). Writes, aggregates and
 * transactions are separate slices. Everything is synchronous underneath; the promises resolve immediately, so a
 * Durable Object cannot interleave another request between two awaited queries of one handler.
 */
export function createPrismaLite(meta: Meta, sql: SqlRunner) {
  const engine = new Engine(meta, sql);
  const byDelegate = new Map(
    Object.keys(meta.models).map(m => [m[0].toLowerCase() + m.slice(1), m])
  );
  const delegate = (model: string) => ({
    findMany: async (args?: Record<string, unknown>) => engine.findMany(model, args),
    findFirst: async (args?: Record<string, unknown>) =>
      engine.findMany(model, { ...args, take: 1 })[0] ?? null,
    findUnique: async (args: Record<string, unknown>) =>
      engine.findMany(model, {
        ...args,
        where: expandUnique(meta, model, args.where as Record<string, unknown>),
        take: 1,
      })[0] ?? null,
    count: async (args?: Record<string, unknown>) => engine.count(model, args),
  });
  return new Proxy({} as Record<string, ReturnType<typeof delegate>>, {
    get(_t, prop: string) {
      const model = byDelegate.get(prop);
      if (!model) throw new Error(`prisma-lite: no model delegate "${prop}" in this database`);
      return delegate(model);
    },
  });
}

/** `{ storeId_slug: { storeId, slug } }` -> `{ storeId, slug }` (Prisma's compound-unique selector). */
function expandUnique(
  meta: Meta,
  model: string,
  where: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const uniques = meta.models[model].uniques.concat([meta.models[model].pk]);
  for (const [k, v] of Object.entries(where)) {
    const hit = uniques.find(u => u.length > 1 && u.join('_') === k);
    if (hit && v && typeof v === 'object') Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}
