/**
 * NEON-ZERO-1: models whose rows moved to Cloudflare D1, and the one place that makes every way of reaching them agree.
 *
 * The API registers a router once at boot. `prisma.<model>.<method>(...)` (the `withStore` transaction IS the `prisma`
 * proxy) asks `route` first; so does a model reached through a RAW transaction client, because every function in this
 * package that hands a caller a raw `tx` (`withMoneyTx`, `withTenantContext`, `scopeTransaction`, `prisma.$transaction`)
 * wraps it with `routeTx`. Without that, a callback holding a raw tx would read and write the retired Postgres tables after
 * the cutover. The Postgres leg is a lazy closure: a D1-served call never needs a Postgres client.
 *
 * Routed models are never usable inside an array `$transaction([...])` (the call is async, not a PrismaPromise);
 * tests/unit/platform-routed-models-guard.test.ts fails the build if any caller does that.
 */
export interface ModelRouter {
  models: ReadonlySet<string>;
  route(
    model: string,
    method: string,
    args: unknown[],
    postgres: () => Promise<unknown>
  ): Promise<unknown>;
}
let modelRouter: ModelRouter | undefined;
export function setModelRouter(router: ModelRouter | undefined): void {
  modelRouter = router;
}
export const getModelRouter = (): ModelRouter | undefined => modelRouter;

export const ROUTED_METHODS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

export function routedDelegate(
  model: string,
  postgres: () => unknown,
  router: ModelRouter
): object {
  return new Proxy(
    {},
    {
      get(_t, method) {
        if (typeof method !== 'string' || !ROUTED_METHODS.has(method))
          return (postgres() as Record<string | symbol, unknown>)[method];
        return (...args: unknown[]) =>
          router.route(model, method, args, async () =>
            (postgres() as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](...args)
          );
      },
    }
  );
}

const wrapperToTx = new WeakMap<object, object>();

/** The raw transaction a `routeTx` wrapper stands for (identity-keyed registries, e.g. after-commit hooks, use it). */
export const unwrapTx = <T extends object>(tx: T): T =>
  (wrapperToTx.get(tx) as T | undefined) ?? tx;

/**
 * A raw Prisma transaction client whose routed models go through the router. Everything else is the raw client, untouched
 * (functions are bound to it). With no router registered the client is returned as is.
 */
export function routeTx<T extends object>(tx: T): T {
  const router = modelRouter;
  if (!router || wrapperToTx.has(tx)) return tx;
  const wrapper = new Proxy(tx, {
    get(target, prop) {
      if (typeof prop === 'string' && router.models.has(prop))
        return routedDelegate(prop, () => Reflect.get(target, prop, target), router);
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  wrapperToTx.set(wrapper, tx);
  return wrapper;
}
