// Database Package - Prisma Client Export
import { PrismaClient } from '@prisma/client';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { applyGucs, gucStatements, type TenantGucs } from './tenant-gucs';
import {
  tenantStorage as tenantStorageRaw,
  txGucs,
  storeScope,
  guardHatch,
  ambientScope as ambientScopeImpl,
} from './tenant-scope';
import { setTenantGucs as setTenantGucsImpl } from './tenant-gucs';
import { getModelRouter, routeTx, routedDelegate } from './tx-route';
export { setModelRouter, type ModelRouter, routeTx } from './tx-route';
import type { AppPrismaClient } from './client';
import { baseClient } from './request-db';
import { dropHiddenStores } from './job-store-guard';
import { afterTxCommit, registerTxHooks, runCommitHooks } from './tx-hooks';

export {
  withHiddenStores,
  withoutHiddenStores,
  dropHiddenStores,
  type HiddenStoresScope,
} from './job-store-guard';

// The client factory, the per-request client binding and the process singleton
// live in ./client and ./request-db. Everything below resolves its client
// through `basePrisma()`: the request-bound client when a Worker bound one with
// `runWithRequestDb`, else the lazily created Node singleton.
export { createPrismaClient, createPrismaClientWithAdapter, resolvePoolConfig } from './client';
export type { AppPrismaClient, DbClient, CreatePrismaClientOptions } from './client';
export {
  runWithRequestDb,
  createIsolateDb,
  hasRequestDb,
  type RunWithRequestDbOptions,
  type IsolateDb,
  type IsolateDbOptions,
} from './request-db';
export { ClientPool, ClientPoolTimeout, ConnectionScope } from './client-pool';
export {
  TenantScopeViolation,
  assertTenantScoped,
  assertRawScoped,
  storeIdModels,
  TENANT_CHILD_MODELS,
  IDENTITY_MODELS,
  USER_KEYED_MODELS,
  GLOBAL_MODELS,
  setDbHopObserver,
  setModelWriteObserver,
  notifyModelWrite,
  setRoutedModelGuard,
  type ModelWriteEvent,
} from './tenant-guard';
export { ambientScope, type AmbientScope, type TenantGuardHatch } from './tenant-scope';
export type { ClientLease, ClientPoolOptions } from './client-pool';

const basePrisma = (): AppPrismaClient => baseClient();

/**
 * Run `fn` and AWAIT its result inside the caller's async-context scope.
 *
 * A Prisma query is LAZY: `tx.user.findUnique(...)` returns a PrismaPromise that does
 * nothing until something calls `.then`, and the code-level tenant guard (R-EBDA-003)
 * reads the ambient scope at that moment. `scope.run(x, fn)` with an `fn` that RETURNS
 * such a promise (`withUser(id, tx => tx.user.findUnique(...))`) hands it back out of the
 * scope unawaited, so the `.then` (and the guard) ran outside it and saw no tenant at all,
 * while the query itself still ran on the scoped transaction. Awaiting inside the scope
 * keeps both on the same side. Every `*.run(...)` in this module goes through here.
 */
async function settleInScope<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  return await fn();
}

/**
 * The client the exported `prisma` resolves to right now — an explicit handle
 * for the few callers that need the client itself (a Worker shell, a script
 * that disconnects), not a transaction. Prefer the `prisma` export.
 */
export function getDb(): AppPrismaClient {
  return baseClient();
}

// ---------------------------------------------------------------------------
// Tenant-scoped RLS via AsyncLocalStorage
// ---------------------------------------------------------------------------

type TenantTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * The active tenant transaction for the current async context, and (`txGucs`, in
 * `tenant-scope.ts`) the RLS settings it was opened with, so a SECOND transaction
 * started from inside it can carry the same ones (see `$transaction` in the proxy
 * below). `storeScope` is a store scope WITHOUT a long-lived transaction — see
 * `runInStoreScope`. The state lives in `tenant-scope.ts` because the code-level
 * tenant guard (`tenant-guard.ts`), installed by the client factory, reads it too.
 */
const tenantStorage = tenantStorageRaw as unknown as AsyncLocalStorage<TenantTx>;

/** The RLS settings in force on this async context, if any. */
function ambientGucs(): TenantGucs | undefined {
  const tx = tenantStorage.getStore();
  if (tx) return txGucs.get(tx as object);
  const scope = storeScope.getStore();
  return scope ? { storeId: scope.storeId, userId: scope.userId } : undefined;
}

/**
 * A deferred query issued inside `runInStoreScope`. Lazy like a PrismaPromise:
 * nothing runs until it is awaited, and then it runs in its own short
 * `runInTenantContext`. Inside a batch `prisma.$transaction([...])` the whole
 * batch instead runs in ONE tenant transaction via `exec` (see
 * `transactionWithGucs`), so batch atomicity is kept.
 */
const SCOPED_OP = Symbol('forceScopedOp');
interface ScopedOp extends PromiseLike<unknown> {
  [SCOPED_OP]: true;
  exec: () => Promise<unknown>;
}

function isScopedOp(v: unknown): v is ScopedOp {
  return Boolean(v && typeof v === 'object' && (v as Record<symbol, unknown>)[SCOPED_OP]);
}

function scopedOp(
  storeId: string | undefined,
  exec: () => Promise<unknown>,
  userId?: string
): ScopedOp & Promise<unknown> {
  let started: Promise<unknown> | undefined;
  const run = () => (started ??= runInTenantContext(storeId, exec, userId));
  const op = {
    [SCOPED_OP]: true as const,
    exec,
    then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => run().then(a, b),
    catch: (b?: (e: unknown) => unknown) => run().catch(b),
    finally: (f?: () => void) => run().finally(f),
    [Symbol.toStringTag]: 'ScopedPrismaPromise',
  };
  return op as unknown as ScopedOp & Promise<unknown>;
}

/**
 * `prisma.$transaction` when RLS settings are in force on this context.
 *
 * `$transaction` is never routed to the ambient tenant transaction (see
 * `hasTenantContext`), so it opens a NEW transaction on another connection —
 * and that connection used to carry none of the settings. Every table with a
 * STRICT policy (store_id = app.current_store_id, no contextless allowance)
 * then read as empty and rejected writes, while allow-contextless tables
 * silently lost their tenant scoping. Measured on 2026-09-25 under a real
 * `ebda_app` login: inside `runInTenantContext`, a direct count of
 * `ai_recommendation` returned 2 rows, the same count through `withMoneyTx`
 * or a batch `$transaction([...])` returned 0.
 *
 * The new transaction still opens separately (nesting is impossible in
 * Prisma and callers rely on their own isolation/timeout options); it now
 * starts with the same `SET LOCAL`s. Inert on a BYPASSRLS role.
 */
function transactionWithGucs(gucs: TenantGucs) {
  const client = basePrisma();
  const base = client.$transaction.bind(client) as (...a: unknown[]) => Promise<unknown>;
  return (arg: unknown, opts?: unknown): Promise<unknown> => {
    if (typeof arg === 'function') {
      const fn = arg as (tx: TenantTx) => Promise<unknown>;
      return base(async (tx: TenantTx) => {
        await applyGucs(tx, gucs);
        return fn(routeTx(tx));
      }, opts);
    }
    if (Array.isArray(arg)) {
      if (arg.length > 0 && arg.every(isScopedOp)) {
        return runInTenantContext(gucs.storeId, async () => {
          const out: unknown[] = [];
          for (const op of arg) out.push(await op.exec());
          return out;
        });
      }
      const sets = gucStatements(gucs).map(({ sql, params }) =>
        client.$queryRawUnsafe(sql, ...params)
      );
      return base([...sets, ...arg], opts).then(r => (r as unknown[]).slice(sets.length));
    }
    return base(arg, opts);
  };
}

function isModelDelegate(prop: string, value: unknown): value is object {
  return (
    prop[0] !== '$' &&
    prop[0] !== '_' &&
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { findMany?: unknown }).findMany === 'function'
  );
}

/**
 * Tenant transactions whose `runInTenantContext` callback has already
 * returned — i.e. Prisma is committing (or has committed) them.
 *
 * Why this exists: the API holds ONE interactive transaction per request in
 * `tenantStorage` and commits it on `res.on('finish')` (see
 * apps/api/src/middleware/tenant-context.ts). A fire-and-forget promise
 * started inside the handler INHERITS this AsyncLocalStorage context, so any
 * Prisma call it makes after the response flushes lands on a committed
 * transaction and throws P2028 ("Transaction already closed"). Every such
 * call site wraps itself in a logging `.catch`, so the work silently never
 * happened — return-confirmation emails never sent, affiliate audit events
 * never written, orphaned R2 objects never reclaimed.
 *
 * The transaction object itself is the only stable identity we have for
 * "this request's tx", hence a WeakSet (entries are collected with the tx).
 *
 * This is DETECTION ONLY. The proxy still routes the call to the closed
 * transaction exactly as before — the P2028 still throws, byte-identical
 * behaviour — but a registered reporter gets told, with the property name
 * and a stack, so the failure is loud instead of silent. Routing the call to
 * the base client instead would drop the `app.current_store_id` GUC that
 * `runInTenantContext` set, trading a transaction bug for a tenancy bug.
 */
const closedTenantTxs = new WeakSet<object>();

/**
 * #1598: whether the closed tx's callback RESOLVED (about to COMMIT) or
 * THREW (about to ROLL BACK). A stray access after a COMMIT is the real
 * defect this module exists to catch — deferred work silently lost. A stray
 * access after a ROLLBACK is much less alarming: the request already errored
 * and everything else it did is undone too, so a P2028 there is inconsequential
 * noise on the error path, not a silent loss of committed work. Tagged
 * separately from `closedTenantTxs` (rather than folding the reason into that
 * WeakSet's value) so the WeakSet's own "has this tx closed" check stays a
 * single membership test.
 */
const closedTenantTxReason = new WeakMap<object, 'committed' | 'aborted'>();

/** What a closed-tenant-tx access reports to the host application. */
export interface ClosedTenantTxAccess {
  /** The Prisma property that was read (model accessor or raw helper). */
  property: string;
  /** Capture stack of the offending access, so the call site is nameable. */
  stack?: string;
  /** Whether the transaction was about to commit or had already rolled back. */
  reason: 'committed' | 'aborted';
}

let closedTenantTxReporter: ((info: ClosedTenantTxAccess) => void) | null = null;

/**
 * Register a handler invoked whenever code touches the ambient tenant
 * transaction AFTER its `runInTenantContext` callback returned.
 *
 * The API registers one at boot that logs at error level and fires the
 * standard Telegram alert (see apps/api/src/lib/after-tenant-commit.ts).
 * Registering is optional — with no reporter this is a no-op, which is what
 * scripts, migrations and tests get.
 */
export function onClosedTenantTxAccess(
  handler: ((info: ClosedTenantTxAccess) => void) | null
): void {
  closedTenantTxReporter = handler;
}

function reportClosedTenantTxAccess(property: string, tx: object): void {
  const reporter = closedTenantTxReporter;
  if (!reporter) return;
  const reason = closedTenantTxReason.get(tx) ?? 'committed';
  try {
    reporter({
      property,
      reason,
      stack: new Error('Prisma call on a committed tenant transaction').stack,
    });
  } catch {
    // A broken reporter must never change the behaviour of the query path.
  }
}

/**
 * Model-level property names on PrismaClient (e.g. `user`, `product`, `store`).
 * When a tenant transaction is active, reads of these properties are proxied
 * to the transaction client so every query runs inside the SET LOCAL scope.
 *
 * We also proxy `$queryRaw`, `$executeRaw`, and `$queryRawUnsafe` /
 * `$executeRawUnsafe` so raw queries respect the tenant context too.
 */
const PROXIED_PRISMA_METHODS = new Set([
  // Raw query helpers
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

function isProxiedProp(prop: string | symbol): boolean {
  if (typeof prop !== 'string') return false;
  // Proxy model accessors (lowercase, no $ prefix) and raw query helpers
  if (PROXIED_PRISMA_METHODS.has(prop)) return true;
  // Model accessors: lowercase first letter, no $ prefix (e.g. 'user', 'product')
  return prop.length > 0 && prop[0] !== '$' && prop[0] === prop[0].toLowerCase();
}

/**
 * Whether an ambient tenant transaction (from `runInTenantContext`) is active
 * on this async context.
 *
 * Exists because `$transaction` is NOT proxied to the tenant transaction: the
 * proxy above only forwards model accessors and raw helpers (`isProxiedProp`
 * rejects anything starting with `$`). So `prisma.$transaction(...)` inside a
 * request opens a SEPARATE transaction on a different connection, which cannot
 * see rows the request has already written in the outer tenant transaction —
 * that transaction does not commit until the response finishes.
 *
 * That is not hypothetical: `CartService.addItem` created the cart via the
 * proxy (outer tx, uncommitted) and then inserted the cart item inside a nested
 * `$transaction`, so the FK on `cart_items.cart_id` pointed at a row the nested
 * transaction could not see → P2003, a 500 on the first add-to-cart of a
 * session. Call sites that write-then-read within one request must use this to
 * stay on the ambient transaction.
 *
 * The call sites that do, as of 2026-09-13 — keep this list current, because
 * the next omission looks exactly like the last three:
 *   - `CartService.addItem`    (cart_items unique + FK)
 *   - `CartService.addBundle`  (cart_bundles unique + FK)
 *   - `CartService.addItems`   (bulk /cart/sync — same shape, and it kept the
 *                               defect through THREE separate audit reports
 *                               because the first-party storefront calls the
 *                               sibling public route, which is mounted outside
 *                               `tenantContext` and so always took the safe
 *                               branch)
 *   - `AuthService.eraseAccount` (2026-09-23 — a DIFFERENT shape from the cart
 *                               three: no write-then-read, so it would not have
 *                               failed loudly. The `withMoneyTx` simply committed
 *                               the irreversible PII anonymization on a second,
 *                               GUC-less connection, independently of the request
 *                               transaction — so an abort after it destroyed the
 *                               data while rolling back its own audit row. Latent
 *                               until the merchant-initiated
 *                               `POST /stores/:storeId/customers/:customerId/erase`
 *                               route made it reachable under `tenantContext`;
 *                               `/auth/me/erase` and the retention cron are both
 *                               context-less.)
 *
 * The shape to look for: a service that calls `getOrCreate`-then-`$transaction`
 * and is reachable from a router mounted under `tenantContext`. Note the
 * eraseAccount case widens that: ANY `$transaction` reachable under
 * `tenantContext` is already wrong on RLS scoping and commit atomicity, even
 * when it never reads back what it wrote and so never throws.
 *
 * The ARRAY form is no exception (measured 2026-09-25, #1787): a
 * `prisma.$transaction([prisma.x.update(...)])` batch built from proxied
 * accessors inside `runInTenantContext` runs on its own connection, cannot see
 * the request's uncommitted rows, and commits even when the request then rolls
 * back (it carries the request's GUCs since `transactionWithGucs`, which was
 * not true when this was first measured). Route handlers open these too — the full
 * enumeration, including `withMoneyTx` callers, is
 * `tests/unit/nested-transaction-registry.test.ts`.
 *
 * Prisma does not support nested interactive transactions in any case.
 *
 * Since 2026-09-25 that separate transaction at least starts with the SAME RLS
 * settings (`transactionWithGucs` below), so it no longer reads a STRICT-policy
 * table as empty. It is still a different connection with its own commit —
 * everything above about write-then-read and commit atomicity still holds.
 */
export function hasTenantContext(): boolean {
  return tenantStorage.getStore() !== undefined;
}

/**
 * The RLS settings of the ambient tenant TRANSACTION, if one is open —
 * `undefined` outside one (including inside `runInStoreScope`, which holds no
 * transaction). Lets a caller check WHICH store the open transaction is scoped
 * to, not merely that one exists: `runInTenantContext(undefined, fn, userId)`
 * (the user-scoped routers) opens a transaction with NO store GUC, and a
 * strict-table read on it returns `[]` (issue 2041).
 */
/**
 * The store the current code is scoped to (the ambient tenant transaction's store, else the
 * `runInStoreScope` store). THROWS when there is none: it exists to fill `where: { storeId }`
 * deep in a call chain that only has a row id, so the code-level tenant guard (R-EBDA-003)
 * and the SQL both carry the store filter. Prefer the caller's own `storeId` when it has one.
 */
export function currentStoreId(): string {
  const id = ambientScopeImpl().storeId;
  if (!id) {
    throw new Error(
      'currentStoreId(): no ambient store (run inside runInTenantContext / withStore / runInStoreScope)'
    );
  }
  return id;
}

export function currentTenantGucs(): TenantGucs | undefined {
  const tx = tenantStorage.getStore();
  return tx ? txGucs.get(tx as object) : undefined;
}

/**
 * Proxy-wrapped Prisma client.
 *
 * Which client it talks to is decided PER ACCESS (`basePrisma()`): the
 * request-bound client when a Worker bound one with `runWithRequestDb`, else
 * the Node process singleton. Callers keep importing the one `prisma`.
 *
 * When called inside `runInTenantContext`, model accessors and raw query
 * helpers transparently delegate to the tenant-scoped transaction that
 * already has `app.current_store_id` set (transaction-locally).
 *
 * Outside a tenant context the proxy passes through to the base client. Under
 * the strict-RLS role that client reads NO tenant rows: cross-store work goes
 * through `acrossStores`, the SECURITY DEFINER functions or `withStore`, never
 * through a bypass (see the RLS section of CLAUDE.md).
 */
export const prisma = new Proxy({} as AppPrismaClient, {
  get(_target, prop) {
    // NEON-ZERO-1: a model the API has moved to D1 resolves per CALL (the cutover switch is read then), and only
    // the Postgres branch of that call touches `basePrisma()` - a D1-served call never needs a Postgres client.
    const modelRouter = getModelRouter();
    if (modelRouter && typeof prop === 'string' && modelRouter.models.has(prop))
      return routedDelegate(prop, () => proxiedGet(prop), modelRouter);
    return proxiedGet(prop);
  },
  // The target is an empty shell, so the remaining traps forward to the live
  // client. `vi.spyOn(prisma, '$transaction')`, `'user' in prisma` and friends
  // then behave as they did when the target was the client itself.
  has: (_t, prop) => prop in basePrisma(),
  set: (_t, prop, value) => Reflect.set(basePrisma(), prop, value),
  defineProperty: (_t, prop, desc) => Reflect.defineProperty(basePrisma(), prop, desc),
  deleteProperty: (_t, prop) => Reflect.deleteProperty(basePrisma(), prop),
  ownKeys: () => Reflect.ownKeys(basePrisma()),
  getOwnPropertyDescriptor: (_t, prop) => {
    const d = Reflect.getOwnPropertyDescriptor(basePrisma(), prop);
    if (d) d.configurable = true;
    return d;
  },
  // Cast to the OMIT-NARROWED type, not bare PrismaClient. With bare
  // PrismaClient the types would still advertise `passwordHash` while the
  // runtime omits it — code reading it would compile and silently get
  // undefined. Narrowing makes a missing per-query opt-in a COMPILE error.
}) as AppPrismaClient;

function proxiedGet(prop: string | symbol): unknown {
  {
    const target = basePrisma();
    const receiver = target;
    const tx = tenantStorage.getStore();
    if (tx && isProxiedProp(prop)) {
      // Detection only — see `closedTenantTxs`. Routing is unchanged.
      if (closedTenantTxs.has(tx as object)) {
        reportClosedTenantTxAccess(String(prop), tx as object);
      }
      return Reflect.get(tx, prop, tx);
    }
    if (prop === '$transaction') {
      const gucs = ambientGucs();
      if (gucs && (gucs.storeId || gucs.userId)) return transactionWithGucs(gucs);
    }
    // `runInStoreScope`: no transaction is open, so each model call and raw
    // query runs in its own short tenant transaction instead.
    const scope = tx ? undefined : storeScope.getStore();
    if (scope && typeof prop === 'string') {
      const self = prisma as unknown as Record<string, unknown>;
      if (PROXIED_PRISMA_METHODS.has(prop)) {
        return (...args: unknown[]) =>
          scopedOp(
            scope.storeId,
            () => (self[prop] as (...a: unknown[]) => Promise<unknown>)(...args),
            scope.userId
          );
      }
      const value = Reflect.get(target, prop, receiver);
      if (isModelDelegate(prop, value)) {
        return new Proxy(value, {
          get(delegate, method, r) {
            const v = Reflect.get(delegate, method, r);
            if (typeof v !== 'function' || typeof method !== 'string') return v;
            return (...args: unknown[]) =>
              scopedOp(
                scope.storeId,
                () => {
                  const d = self[prop] as Record<string, (...a: unknown[]) => Promise<unknown>>;
                  return d[method](...args);
                },
                scope.userId
              );
          },
        });
      }
      return value;
    }
    const value = Reflect.get(target, prop, receiver);
    // `$connect` / `$disconnect` / `$on` / `$extends` / `$use` are called as
    // `prisma.$x()`, i.e. with the proxy as `this`; they must act on the
    // client resolved NOW, not on whatever the proxy resolves to later.
    if (prop === '$transaction' && typeof value === 'function' && getModelRouter()) {
      // a raw client handed to a callback must route the D1 models too (tx-route.ts)
      const bound = value.bind(target) as (...a: unknown[]) => unknown;
      return (arg: unknown, opts?: unknown) =>
        typeof arg === 'function'
          ? bound((tx: object) => (arg as (t: object) => unknown)(routeTx(tx)), opts)
          : bound(arg, opts);
    }
    return typeof value === 'function' && typeof prop === 'string' && prop[0] === '$'
      ? value.bind(target)
      : value;
  }
}

// Re-export everything from Prisma client (types, enums, Prisma namespace)
export * from '@prisma/client';
export { Prisma } from '@prisma/client';

// Explicit enum re-exports for environments where barrel re-exports may not resolve
export {
  UserRole,
  UserStatus,
  StoreStatus,
  StorePlan,
  StoreTemplate,
  ProductStatus,
  InventoryChangeType,
  PaymentStatus,
  OrderStatus,
  OrderPaymentStatus,
  ReturnType,
  ReturnStatus,
  PaymentProvider,
  ProviderHealthStatus,
  CouponType,
  VerificationTokenType,
  LoyaltyTransactionType,
  AccountType,
  JournalEntrySource,
  JournalEntryStatus,
  SupplierPaymentTerms,
  PurchaseOrderStatus,
  StockAdjustmentType,
  StockAdjustmentStatus,
  ExpenseStatus,
  ReorderSuggestionStatus,
  DeadStockFlagStatus,
  AnomalyScope,
  AnomalyMetric,
  AnomalySeverity,
  RfmSegment,
  CampaignStatus,
  CampaignRecipientStatus,
} from '@prisma/client';

export { prisma as db };

// Money-safe transaction wrapper (Neon pgbouncer P2028 guard). Use for every
// interactive $transaction call site. See ./with-money-tx.ts.
export { withMoneyTx } from './with-money-tx';
export { afterTxCommit, setCommitHookErrorReporter } from './tx-hooks';

// Set RLS settings on a caller-opened transaction. See ./tenant-gucs.ts.
export { setTenantGucs, type TenantGucs } from './tenant-gucs';

/**
 * Run a callback inside a Prisma interactive transaction with
 * `app.current_store_id` set via SET LOCAL. All Prisma queries executed
 * through the `prisma` export (the proxy) within the callback
 * automatically use this transaction — no code changes needed in services.
 *
 * The tenant context is stored in AsyncLocalStorage, so it flows through
 * any async operations within the callback.
 *
 * If the callback throws, the transaction rolls back automatically.
 *
 * @param storeId RLS cutover Phase 1c (user-scoped routers, see
 *   apps/api/src/middleware/tenant-context.ts `userContext`): may be
 *   `undefined` for routers that have no store in scope at all (e.g.
 *   `address.routes.ts` — addresses are user-scoped, FK `user_id`, no
 *   `store_id` column exists). When `undefined`, `app.current_store_id` is
 *   simply never SET LOCAL'd — `current_store_id()` returns NULL and every
 *   store-scoped hybrid policy allow-contextless, IDENTICAL to calling this
 *   function today with no context at all. A *defined* storeId still MUST
 *   be a valid UUID (throws otherwise, same as before) — this only relaxes
 *   the "must pass something" requirement, it does not relax validation of
 *   a value that IS passed.
 * @param userId Optional — additionally sets `app.current_user_id` via SET
 *   LOCAL, for the user-scoped RLS policies added in the RLS cutover Phase
 *   1b (e.g. `addresses`, see 20260702170000_rls_close_denyall_tables).
 *   Additive: defaults to `undefined`, in which case the GUC is left unset,
 *   `current_user_id()` returns NULL, and the hybrid user-scoped policies
 *   allow-contextless — IDENTICAL to today's behavior. Only callers that
 *   explicitly pass a userId (tenant-context.ts, from `req.user?.userId`)
 *   opt into the per-user backstop.
 *
 * @example
 *   // In Express middleware:
 *   await runInTenantContext(storeId, async () => {
 *     // All prisma.product.findMany() etc. calls inside here
 *     // are scoped to this storeId via RLS
 *     await handler(req, res);
 *   }, req.user?.userId);
 *
 * @example
 *   // User-scoped router with no store in scope (address.routes.ts):
 *   await runInTenantContext(undefined, async () => {
 *     // app.current_store_id stays unset; app.current_user_id is set.
 *     await handler(req, res);
 *   }, req.user!.userId);
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` after the ambient tenant transaction COMMITS — for side effects that must not see (or
 * announce) uncommitted rows, e.g. an Inngest event, when there is no request deferral scope
 * (`deferAfterTenantCommit` covers requests). Returns false — and registers nothing — when there is
 * no ambient transaction, or it was not opened by `runInTenantContext` (a caller's own
 * `$transaction` / `withMoneyTx` bound with `scopeTransaction`): the caller decides what to do then.
 * Dropped on rollback. Callbacks run outside the closed transaction's context; a throw is swallowed
 * (the transaction already committed; the callback owns its own error reporting).
 */
export function afterTenantTxCommit(fn: () => unknown): boolean {
  const tx = tenantStorage.getStore() as object | undefined;
  return tx ? afterTxCommit(tx, fn) : false;
}

export async function runInTenantContext<T>(
  storeId: string | undefined,
  fn: () => Promise<T>,
  userId?: string
): Promise<T> {
  if (storeId !== undefined && !UUID_RE.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  const hooks: Array<() => unknown> = [];
  const result = await basePrisma().$transaction(
    async tx => {
      registerTxHooks(tx as object, hooks);
      await applyGucs(tx, { storeId, userId });
      txGucs.set(tx as object, { storeId, userId });
      try {
        const result = await tenantStorage.run(tx, () => settleInScope(fn));
        // The callback RESOLVED, so Prisma is about to COMMIT. #1598: tag it
        // BEFORE the shared `finally` below runs, so a reporter sees
        // 'committed' — the real defect this module exists to catch.
        closedTenantTxReason.set(tx as object, 'committed');
        return result;
      } catch (err) {
        // The callback THREW, so Prisma is about to ROLL BACK. A stray access
        // after this point is a P2028 on the error path, where every other
        // write this request made is undone too — routine, not a silent loss
        // of committed work. #1598.
        closedTenantTxReason.set(tx as object, 'aborted');
        throw err;
      } finally {
        // Either way, the callback has returned/thrown: from here on, any
        // query that reaches this tx throws P2028. Mark it so the proxy can
        // name the offender instead of leaving a swallowed rejection.
        // Behaviour is otherwise unchanged.
        closedTenantTxs.add(tx as object);
      }
    },
    // maxWait raised from Prisma's 2s default — admin dashboards fire 4-6
    // parallel /stores/:id/* requests, each opening an interactive tx for
    // RLS. Neon pgbouncer slot contention under that burst was firing P2028
    // at ~2050ms. 10s gives headroom without masking real saturation.
    { maxWait: 10000, timeout: 30000 }
  );
  // COMMITTED (a rollback threw above and the hooks are dropped with it).
  await runCommitHooks(hooks.map(h => () => tenantStorage.exit(() => h())));
  hooks.length = 0;
  return result;
}

/**
 * Execute a callback within a tenant-scoped transaction (explicit tx version).
 * Prefer `runInTenantContext` for automatic proxy-based scoping.
 * This version passes the transaction client directly for cases where
 * you need explicit control.
 */
export async function withTenantContext<T>(
  storeId: string,
  fn: (tx: TenantTx) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  return basePrisma().$transaction(
    async tx => {
      await applyGucs(tx, { storeId });
      // Ambient for the code-level tenant guard (and the proxy), like runInTenantContext.
      txGucs.set(tx as object, { storeId });
      return tenantStorage.run(tx, () => settleInScope(() => fn(routeTx(tx))));
    },
    { maxWait: 10000, timeout: 30000 }
  );
}

/**
 * Scope every Prisma call in `fn` to `storeId` under RLS WITHOUT holding one
 * transaction open for the whole of `fn`.
 *
 * For long-running per-store work — the bulk-AI Inngest jobs, which interleave
 * Gemini calls and multi-second throttles between queries. Those jobs were
 * once wrapped in `runInTenantContext`; its 30s interactive transaction
 * expired mid-sweep (#461), so the wrapper was removed on the belief that the
 * jobs touch no RLS-protected table. They do: `bulk_ai_jobs`, `ai_usage`,
 * `ai_recommendation`, `store_faqs` and `store_howtos` all carry STRICT
 * policies, so under `ebda_app` every one of those jobs would read nothing
 * and fail its first `bulkAiJob.update` (P2025).
 *
 * Inside the scope, each model call / raw query runs in its own short
 * `runInTenantContext(storeId, …)`; `$transaction` / `withMoneyTx` start with
 * the store's `SET LOCAL`; an explicit `runInTenantContext` / `withRlsBypass`
 * inside the scope behaves exactly as it does anywhere else. Results are
 * identical on the owner role — the only cost is one short transaction per
 * query, negligible next to an AI call.
 */
export function runInStoreScope<T>(
  storeId: string,
  fn: () => Promise<T>,
  userId?: string
): Promise<T> {
  if (!UUID_RE.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  return storeScope.run({ storeId, userId }, () => settleInScope(fn));
}

/**
 * NEON-ZERO (Ruling NZ-C-1): a USER scope with no store and no long-lived transaction. Like `runInStoreScope`, a `prisma` call
 * inside runs in its own short tenant transaction carrying `app.current_user_id`, so a request that never touches Postgres
 * (the super-admin hub once its platform families are on D1) never opens a connection, and a handler that still does keeps
 * the user-keyed RLS it had under the request transaction.
 */
export function runInUserScope<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return storeScope.run({ userId }, () => settleInScope(fn));
}

// ---------------------------------------------------------------------------
// Cross-store and contextless access under STRICT RLS (R-EBDA-001)
// ---------------------------------------------------------------------------
//
// The app role (`ebda_app`) has no BYPASSRLS and the policies carry no bypass
// GUC and no contextless allowance: a query with no store set reads NO tenant
// rows and its writes are rejected. Code that is not inside a request's tenant
// transaction therefore reaches tenant data in exactly three ways:
//
//   1. `withStore(storeId, fn)`      — the store is known (a webhook that
//                                      resolved its order, an Inngest event with
//                                      a storeId, a public route after it
//                                      resolved the host);
//   2. `withUser(userId, fn)`        — the user is known (auth flows) — the
//                                      `users` / `addresses` policies key on
//                                      `app.current_user_id`;
//   3. `acrossStores(fn)`            — a cron/super-admin sweep: one short
//                                      tenant transaction PER STORE;
//   4. a SECURITY DEFINER function   — the narrow, named lookups that must run
//                                      BEFORE a store or user is known (host ->
//                                      store, login email -> user id, webhook
//                                      provider reference -> store). They live
//                                      in the strict-RLS migration and are called
//                                      through `$queryRaw`.

/**
 * Run `fn` scoped to `storeId` under RLS, whether or not the caller already
 * has a tenant context.
 *
 *  - Inside a tenant TRANSACTION already scoped to this store: reuse it, so the
 *    work is atomic with the request (a second connection could not see the
 *    request's uncommitted rows).
 *  - Inside `runInStoreScope` for this store: each query is its own short
 *    transaction, as everywhere in that scope.
 *  - Anything else — no context, or a context for a DIFFERENT store or none:
 *    open a short `runInTenantContext(storeId, ...)`.
 *
 * `fn` receives the `prisma` proxy typed as a transaction client, so existing
 * `tx.model.findMany(...)` code moves over without change.
 */
export async function withStore<T>(storeId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const run = () => fn(prisma as unknown as TenantTx);
  if (currentTenantGucs()?.storeId === storeId) return run();
  if (!tenantStorage.getStore() && storeScope.getStore()?.storeId === storeId) return run();
  // NEON-ZERO (Ruling NZ-C-3): a store served by its Durable Object has no Postgres rows to scope to, so a caller outside any
  // request transaction (the super-admin hub, a job step) gets the lazy per-query store scope instead of a BEGIN that cannot connect.
  if (
    !tenantStorage.getStore() &&
    storeScopeResolver &&
    (await storeScopeResolver(storeId)) === 'no-pg'
  )
    return runInStoreScope(storeId, run);
  return runInTenantContext(storeId, run);
}

/**
 * Registered once by the API at boot: says whether a store must NOT open a Postgres transaction ('no-pg': its data is in its
 * Durable Object / D1). Unregistered (Node scripts, unit tests) = every store keeps the Postgres transaction.
 */
/** Registered by the API: the store ids a hub (user-scope) cross-store view covers, or undefined to use the directory definer. */
let hubStoreLister: (() => Promise<string[] | undefined>) | undefined;
export function setHubStoreLister(fn: (() => Promise<string[] | undefined>) | undefined): void {
  hubStoreLister = fn;
}

export type StoreScopeResolver = (storeId: string) => Promise<'pg' | 'no-pg'>;
let storeScopeResolver: StoreScopeResolver | undefined;
export function setStoreScopeResolver(r: StoreScopeResolver | undefined): void {
  storeScopeResolver = r;
}
/** The per-store scope runner `acrossStores` uses (same decision as `withStore`). */
async function runInStoreTx<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (storeScopeResolver && (await storeScopeResolver(storeId)) === 'no-pg')
    return runInStoreScope(storeId, fn);
  return runInTenantContext(storeId, fn);
}

/**
 * Run `fn` as `userId` (and optionally within `storeId`) under RLS: the
 * identity-keyed tables (`users`, `addresses`, `store_staff`) match on
 * `app.current_user_id`. Reuses the ambient transaction when it already carries
 * this user (and store, if one is given).
 */
export function withUser<T>(
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
  storeId?: string
): Promise<T> {
  const run = () => fn(prisma as unknown as TenantTx);
  const ambient = currentTenantGucs();
  if (ambient?.userId === userId && (storeId === undefined || ambient.storeId === storeId)) {
    return run();
  }
  return runInTenantContext(storeId, run, userId);
}

/**
 * One row of the store DIRECTORY: the routing facts and feature flags of a store that is
 * not soft-deleted, read through the `ebda_store_directory()` SECURITY DEFINER function
 * (`stores` is under RLS: a cron has no scope that could read it directly). No secret,
 * no settings: a sweep filters on these, then works on each store inside its OWN tenant
 * transaction (`acrossStores` / `withStore`).
 */
export interface StoreDirectoryEntry {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  accountingEnabled: boolean;
  aiFeaturesEnabled: boolean;
  loyaltyEnabled: boolean;
  hasDomain: boolean;
  hasPendingDomain: boolean;
}

/** Every store that is not soft-deleted (id order), optionally filtered. See `StoreDirectoryEntry`. */
export async function storeDirectory(
  filter?: (s: StoreDirectoryEntry) => boolean,
  opts: { includeDeleted?: boolean } = {}
): Promise<StoreDirectoryEntry[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      slug: string;
      name: string;
      status: string;
      plan: string;
      accounting_enabled: boolean;
      ai_features_enabled: boolean;
      loyalty_enabled: boolean;
      has_domain: boolean;
      has_pending_domain: boolean;
    }>
  >`SELECT * FROM public.ebda_store_directory(${opts.includeDeleted === true})`;
  const all = rows.map(r => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    plan: r.plan,
    accountingEnabled: r.accounting_enabled,
    aiFeaturesEnabled: r.ai_features_enabled,
    loyaltyEnabled: r.loyalty_enabled,
    hasDomain: r.has_domain,
    hasPendingDomain: r.has_pending_domain,
  }));
  const kept = dropHiddenStores(all, s => s.id, 'storeDirectory');
  return filter ? kept.filter(filter) : kept;
}

/**
 * Bind a transaction the CALLER opened (`withMoneyTx`, `prisma.$transaction`) to a tenant
 * scope for the rest of `fn`: sets the RLS GUCs on it (transaction-locally, validated like
 * `runInTenantContext`) AND makes it the ambient tenant transaction, so the `prisma` proxy
 * routes to it and the code-level tenant guard (R-EBDA-003) sees its store. Replaces a bare
 * `setTenantGucs(tx, ...)`, which set the GUCs but left the guard (and the proxy) blind.
 * Used where a store row is created first and its tenant rows in the same transaction
 * (provisioning), or a public flow opens its own transaction.
 */
export async function scopeTransaction<Tx extends object, T>(
  tx: Tx,
  gucs: TenantGucs,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  await setTenantGucsImpl(tx as unknown as Parameters<typeof setTenantGucsImpl>[0], gucs);
  txGucs.set(tx, { ...gucs });
  return tenantStorage.run(tx as unknown as TenantTx, () => settleInScope(() => fn(routeTx(tx))));
}

/**
 * Hatch 'platform-operator' (R-EBDA-003): run `fn` as `userId` with the code-level tenant
 * guard opened for the PLATFORM DIRECTORY only (`Store`, `User`, `StoreStaff` without a
 * store scope), after the `ebda_is_super_admin()` definer confirmed IN THE SAME TRANSACTION
 * that `userId` is an ACTIVE super_admin. RLS still applies underneath (the `stores` and
 * `users` policies admit an active super_admin principal). Store-scoped tenant tables stay
 * closed: a super-admin view of orders or products goes through `acrossStores` or a definer.
 * The callers are enumerated in tests/unit/no-rls-bypass-in-runtime.test.ts.
 */
export function asPlatformOperator<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return withUser(userId, async () => {
    const rows = await prisma.$queryRaw<
      Array<{ ok: boolean }>
    >`SELECT public.ebda_is_super_admin() AS ok`;
    if (rows[0]?.ok !== true) {
      throw new Error('asPlatformOperator: the acting user is not an active super_admin');
    }
    return guardHatch.run('platform-operator', () => settleInScope(fn));
  });
}

export interface AcrossStoresOptions {
  /** Restrict to these stores (default: every store in the directory, i.e. not soft-deleted). */
  storeIds?: string[];
  /** Keep only the directory entries this returns true for, e.g. `s => s.accountingEnabled`. */
  filter?: (s: StoreDirectoryEntry) => boolean;
  /** Stores processed at once, each in its own transaction. Default 4. */
  concurrency?: number;
  /**
   * Called when `fn` throws for one store. When given, that store is skipped and
   * the sweep carries on (a cron must not die on one bad tenant); when omitted
   * the first error rejects the whole call.
   */
  onStoreError?: (storeId: string, err: unknown) => void;
}

/**
 * Run `fn` once per store, each inside its OWN tenant transaction for that
 * store, and return the per-store results. This is how a cron, an Inngest sweep
 * or a super-admin dashboard reads or writes "across tenants" without any
 * bypass: the database only ever shows `fn` the rows of the store it is
 * currently scoped to.
 *
 * Result-shape contract: `fn` sees only ONE store's rows, so a global
 * `take`/`orderBy`/`count` becomes per-store. The caller merges (sum the
 * counts, concatenate the rows, then sort and cut to the global limit).
 * The store ids come from the `ebda_store_directory()` definer: `stores` is
 * under RLS too (R-EBDA-005), so a contextless cron cannot list it directly.
 */
export async function acrossStores<T>(
  fn: (storeId: string) => Promise<T>,
  opts: AcrossStoresOptions = {}
): Promise<Array<{ storeId: string; value: T }>> {
  // NEON-ZERO (Ruling NZ-C-4): inside the platform user scope (`runInUserScope`, the super-admin hub) with no filter, the store
  // list is the registered lister's (D1, capped), not the Postgres directory definer.
  const listed =
    !opts.storeIds &&
    !opts.filter &&
    !tenantStorage.getStore() &&
    storeScope.getStore()?.storeId === undefined
      ? await hubStoreLister?.()
      : undefined;
  const storeIds = opts.storeIds
    ? dropHiddenStores(opts.storeIds, id => id, 'acrossStores')
    : listed
      ? dropHiddenStores(listed, id => id, 'acrossStores')
      : (await storeDirectory(opts.filter)).map(s => s.id);

  const out: Array<{ storeId: string; value: T } | undefined> = new Array(storeIds.length);
  let next = 0;
  let failure: { err: unknown } | undefined;
  const worker = async () => {
    while (!failure) {
      const i = next++;
      if (i >= storeIds.length) return;
      const storeId = storeIds[i];
      try {
        out[i] = { storeId, value: await runInStoreTx(storeId, () => fn(storeId)) };
      } catch (err) {
        if (opts.onStoreError) opts.onStoreError(storeId, err);
        else failure = { err };
      }
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 4, storeIds.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  if (failure) throw failure.err;
  return out.filter((r): r is { storeId: string; value: T } => r !== undefined);
}

/** `acrossStores` for a per-store LIST: the lists concatenated in store order. */
export async function acrossStoresFlat<T>(
  fn: (storeId: string) => Promise<T[]>,
  opts: AcrossStoresOptions = {}
): Promise<T[]> {
  return (await acrossStores(fn, opts)).flatMap(r => r.value);
}

// ---------------------------------------------------------------------------
// Named platform jobs (the cron-side context of a few cross-store definers)
// ---------------------------------------------------------------------------

/**
 * The platform jobs a cross-store SECURITY DEFINER function recognises. A job is
 * a NAME, not a bypass: it opens no table to `ebda_app`, and only the definers
 * that list it (`ebda_is_system_job`) consult it.
 */
export type SystemJob = 'audit-log-retention' | 'webhook-inbox' | 'token-retention';

/**
 * Run `fn` with `app.system_job = job` set TRANSACTION-LOCALLY, so the definer
 * functions that serve a cron (audit retention, the webhook inbox consumer) can
 * tell it from an arbitrary caller. Inside a tenant transaction the setting is
 * put on that transaction for the duration of `fn` and cleared afterwards (the
 * work stays atomic with the request); otherwise `fn` runs in its own short
 * transaction that carries only the job name. Never a session-level setting.
 */
export async function withSystemJob<T>(job: SystemJob, fn: () => Promise<T>): Promise<T> {
  const setJob = (tx: TenantTx, value: string) =>
    tx.$queryRawUnsafe(`SELECT set_config('app.system_job', $1, true)`, value);
  const ambient = tenantStorage.getStore();
  if (ambient) {
    await setJob(ambient, job);
    try {
      return await fn();
    } finally {
      // Best effort: on an aborted transaction the reset cannot run, and the
      // setting dies with the rollback anyway.
      await setJob(ambient, '').catch(() => undefined);
    }
  }
  return basePrisma().$transaction(
    async tx => {
      await setJob(tx, job);
      return tenantStorage.run(tx, () => settleInScope(fn));
    },
    { maxWait: 10000, timeout: 30000 }
  );
}

// ---------------------------------------------------------------------------
// Owner-role transactions (migrations, ops scripts, test fixtures ONLY)
// ---------------------------------------------------------------------------

const ownerRoleChecked = new WeakMap<object, Promise<boolean>>();

async function connectionBypassesRls(client: AppPrismaClient): Promise<boolean> {
  let check = ownerRoleChecked.get(client);
  if (!check) {
    check = client.$queryRaw<
      Array<{ ok: boolean }>
    >`SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user`.then(
      rows => rows[0]?.ok === true
    );
    ownerRoleChecked.set(client, check);
  }
  const ok = await check;
  if (!ok) ownerRoleChecked.delete(client);
  return ok;
}

/**
 * Whether the current connection bypasses RLS BY ITSELF (a superuser or
 * BYPASSRLS owner role). False on the strict-RLS app role. A job that is only
 * correct with an owner-role connection (the destructive R2 orphan sweep) checks
 * this first and skips cleanly instead of reading zero rows.
 */
export async function isOwnerRole(): Promise<boolean> {
  return connectionBypassesRls(basePrisma());
}

/**
 * Run `fn` in a plain transaction on a connection whose role bypasses RLS BY
 * ITSELF (a superuser or BYPASSRLS owner: the `DIRECT_URL` role that runs
 * migrations, an ops script, the integration tests' fixture connection).
 *
 * It sets NO GUC. Ebda's `withRlsBypass` flipped `app.bypass_rls`; Ebda's
 * policies no longer read it. And it REFUSES to run on the strict-RLS app role:
 * every API/Worker query goes through `withStore` / `withUser` / `acrossStores`
 * / a SECURITY DEFINER function instead, and a call that reaches this on
 * `ebda_app` would otherwise read zero rows and report success. The refusal is
 * loud on purpose. `tests/unit/no-rls-bypass-in-runtime.test.ts` keeps
 * `apps/api/src` from importing it at all.
 */
export async function withOwnerTx<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const client = basePrisma();
  if (!(await connectionBypassesRls(client))) {
    throw new Error(
      'withOwnerTx/withRlsBypass: this connection is the strict-RLS app role, which has no ' +
        'bypass. Use withStore(), withUser(), acrossStores() or a SECURITY DEFINER function.'
    );
  }
  // Hatch 'owner-role-tx' (R-EBDA-003): the role was just proven to bypass RLS, so the
  // code-level tenant guard stands aside for this transaction only.
  return guardHatch.run('owner-role-tx', () =>
    client.$transaction(tx => fn(routeTx(tx)), { maxWait: 10000, timeout: 30000 })
  );
}

/** @deprecated Ebda's name. Same as `withOwnerTx`: no GUC, owner role only. */
export const withRlsBypass = withOwnerTx;
