/**
 * Prisma-shaped client over the platform D1 (`PLATFORM_DB`) for the `target: d1` models in
 * packages/cf-schema/model-split.json (NEON-ZERO-1; engine and limits: packages/repo/src/prisma-lite/d1.ts).
 *
 * Absent binding (Node, unit tests, local dev) -> `undefined`: the caller keeps its Postgres path. A deployed Worker
 * always has the binding, so there the D1 client is the only path. NOT for `Store` (its columns are split between D1 and
 * the StoreDO; see lib/store-record.ts) and NOT for identity / store-do models (the client throws on those).
 */
import { cfBindings } from '../cf/bindings';

type PlatformClient = Record<string, any>;
const clients = new WeakMap<object, Promise<PlatformClient>>();

export async function platformDb(): Promise<PlatformClient | undefined> {
  const d1 = (cfBindings() as { PLATFORM_DB?: object } | undefined)?.PLATFORM_DB;
  if (!d1) return undefined;
  let c = clients.get(d1);
  if (!c) {
    c = (async () => {
      // Lazy: the 550 KB model metadata is only parsed by an isolate that actually reads the platform tables.
      const [{ createD1Client }, meta] = await Promise.all([
        import('@ebda-src/repo'),
        import('@ebda-src/prisma-meta'),
      ]);
      return createD1Client(meta.default as never, d1 as never);
    })();
    clients.set(d1, c);
  }
  return c;
}

/** The platform client, or a 503 when the binding is missing in a deployed Worker (never a silent Postgres read). */
export async function requirePlatformDb(): Promise<PlatformClient> {
  const c = await platformDb();
  if (c) return c;
  const { AppError } = await import('../middleware/error-handler');
  throw new AppError(503, 'PLATFORM_DB_UNBOUND', 'Platform database is not bound');
}
