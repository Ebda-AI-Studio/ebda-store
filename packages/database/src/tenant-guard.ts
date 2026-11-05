// Code-level tenant filtering (R-EBDA-003): the SECOND, independent tenant layer.
//
// RLS (R-EBDA-001) is the first layer: the database refuses rows of another store.
// This module is the second: a Prisma query extension, installed by the ONE client
// factory (`createPrismaClient` / `createPrismaClientWithAdapter`), that refuses a
// query before it is sent unless its where/data is visibly scoped to the AMBIENT
// store (the store of the current `runInTenantContext` / `runInStoreScope` /
// `withStore` / `acrossStores` iteration, see `tenant-scope.ts`).
//
// Why both: RLS depends on the connection role (an owner/BYPASSRLS DATABASE_URL turns
// it off silently) and on the GUC being set; this layer depends on neither. And this
// layer catches what RLS cannot see: a query that names a storeId taken from the
// request that differs from the store the request was authorised for.
//
// The rules (fail closed, every environment, no flag turns them off):
//   TENANT models (every model with a `storeId` column, read from the generated schema snapshot,
//   so a NEW tenant model is covered once the snapshot is regenerated; a unit test fails until it is):
//     - find*/count/aggregate/groupBy/update*/delete*: `where.storeId` (top level, an
//       `AND` member, `{ equals }`, an all-equal `{ in }`, or a compound unique key
//       containing storeId) MUST equal the ambient store;
//     - create/createMany*: every row's `storeId` (or `store.connect.id`) MUST equal it;
//     - upsert: both;
//     - a `storeId` written by any update (or nested write) MUST equal it;
//     - no ambient store -> refused.
//   IDENTITY models (`User`, `StoreStaff`: their RLS keys on store OR user): scoped to
//     the ambient store as above, OR keyed to the ambient user (`User.id`,
//     `StoreStaff.userId`), OR the 'platform-operator' hatch.
//   STORE (the tenant root): `where.id` equals the ambient store, OR `where.ownerId`
//     equals the ambient user, OR the 'platform-operator' hatch; a create must name the
//     ambient user as owner.
//   CHILD models (tenant rows with no `storeId`: order_items, product_variants, ...):
//     need an ambient store (RLS scopes them through their parent).
//   RAW SQL ($queryRaw / $executeRaw and the Unsafe forms): with an ambient store or
//     user, RLS is the layer (allowed); with NO scope, the statement may not name a
//     tenant, child, identity or `stores` table (definer calls, catalog queries and
//     `set_config` stay allowed). See R-EBDA-004.
//   The 'owner-role-tx' hatch (`withOwnerTx`, an RLS-bypassing role, refused on
//   `ebda_app`) allows everything.
import { Prisma } from '@prisma/client';
import { ambientScope, type AmbientScope } from './tenant-scope';
import { TENANT_GUARD_SCHEMA } from './tenant-guard-schema.generated';

export class TenantScopeViolation extends Error {
  readonly code = 'TENANT_SCOPE_VIOLATION';
  constructor(
    readonly model: string,
    readonly operation: string,
    readonly reason: string,
    /** The SHAPE of the refused args (keys only, never values): names the call site in a log. */
    readonly shape = ''
  ) {
    // The check runs inside Prisma's promise machinery, so the default 10 frames end in
    // Prisma internals; a longer trace reaches the async frame of the calling service.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    super(`tenant guard: ${model}.${operation} refused: ${reason}${shape ? ` [${shape}]` : ''}`);
    Error.stackTraceLimit = limit;
    this.name = 'TenantScopeViolation';
  }
}

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Model classification (from the runtime DMMF; see tests/unit/tenant-guard-models.test.ts)
// ---------------------------------------------------------------------------

/** Tenant rows WITHOUT a storeId column, scoped by RLS through their parent. */
export const TENANT_CHILD_MODELS: readonly string[] = [
  'BundleItem',
  'CartBundle',
  'CartItem',
  'CountLine',
  'CustomerAddress',
  'JournalLine',
  'OrderItem',
  'Payment',
  'ProductCategory',
  'ProductFaq',
  'ProductImage',
  'ProductOption',
  'ProductOptionValue',
  'ProductTag',
  'ProductVariant',
  'ProductVariantOption',
  'PurchaseOrderItem',
  'ReturnItem',
  'StockAdjustmentItem',
  'WishlistItem',
];

/** storeId models whose RLS ALSO admits the acting user (store OR user). */
export const IDENTITY_MODELS: Readonly<Record<string, string>> = {
  User: 'id',
  StoreStaff: 'userId',
};

export const STORE_MODEL = 'Store';

/**
 * Rows that belong to ONE USER, not to a store (no storeId): their RLS keys on
 * `app.current_user_id`. The key must be the ambient user (`withUser` / `userContext`), or
 * the 'platform-operator' hatch. Value: the user-id column.
 */
export const USER_KEYED_MODELS: Readonly<Record<string, string>> = {
  Address: 'userId',
  // Ruling LEGAL-4: what a user accepted, and the per-recipient email ledger.
  LegalAcceptance: 'userId',
  LegalNoticeDelivery: 'userId',
  OneSignalSubscription: 'userId',
  // Ruling PASSKEY-1: WebAuthn credentials, owned by one user.
  PasskeyCredential: 'userId',
  RefreshToken: 'userId',
  VerificationToken: 'userId',
};

/**
 * Platform-global models: no tenant and no user data (catalog, config, provider-event
 * dedupe). Not guarded. Every model must be in exactly one class; the list is checked
 * against the schema by tests/unit/tenant-guard-models.test.ts, so a new model fails CI
 * until it is classified.
 */
export const GLOBAL_MODELS: readonly string[] = [
  'AnswerEngineProviderConfig',
  'BillingWebhookEvent',
  // Ruling FOUNDING-1: platform billing ledgers keyed by store ids, no store_id column, no tenant data.
  'BillingReferral',
  'BillingGrant',
  // Ruling LEGAL-4: one row per announced policy version, read by every merchant.
  'LegalNoticeSend',
  'Plan',
  // Ruling PROVIDERS-3: platform-wide provider verification evidence (no tenant data).
  'ProviderVerification',
  'ProviderVerificationEvent',
  'SystemSetting',
  // Ruling CI-9: platform-wide CI findings over k-anonymous cohort cells, no store_id and no identifier.
  'CiInsight',
];

interface ModelMeta {
  tenant: Set<string>;
  child: Set<string>;
  /** model -> relation field -> target model */
  relations: Map<string, Map<string, string>>;
  /** table names (lower case) a contextless raw statement may not touch */
  guardedTables: Set<string>;
}

let meta: ModelMeta | undefined;

/**
 * The models with a `storeId` scalar column. Read from the committed schema snapshot, NOT from
 * `Prisma.dmmf`: the DMMF getter throws on Workers ("Prisma.dmmf is not available when running in
 * edge runtimes"), which 500'd every API request the first time this guard shipped. The snapshot
 * is generated from the DMMF (`npm run gen:tenant-guard-schema -w packages/database`) and
 * tests/unit/tenant-guard-schema-snapshot.test.ts fails when it drifts from the real client.
 */
export function storeIdModels(): string[] {
  return TENANT_GUARD_SCHEMA.filter(m => m.storeId).map(m => m.name);
}

function modelMeta(): ModelMeta {
  if (meta) return meta;
  const models = TENANT_GUARD_SCHEMA;
  const tenant = new Set(storeIdModels());
  const child = new Set(TENANT_CHILD_MODELS);
  const relations = new Map<string, Map<string, string>>();
  const guardedTables = new Set<string>();
  for (const m of models) {
    relations.set(m.name, new Map(Object.entries(m.relations)));
    if (tenant.has(m.name) || child.has(m.name) || m.name === STORE_MODEL) {
      guardedTables.add(m.table.toLowerCase());
    }
  }
  for (const name of Object.keys(USER_KEYED_MODELS)) {
    const um = models.find(x => x.name === name);
    if (um) guardedTables.add(um.table.toLowerCase());
  }
  meta = { tenant, child, relations, guardedTables };
  return meta;
}

// ---------------------------------------------------------------------------
// Where / data inspection (pure)
// ---------------------------------------------------------------------------

type Verdict = 'match' | 'mismatch' | 'missing';

/** Collect every constraint on `field` at the top level of `where` and in its AND members. */
function keyVerdict(where: unknown, field: string, expected: string | undefined): Verdict {
  if (!isObj(where)) return 'missing';
  const seen: Verdict[] = [];
  const judge = (v: unknown) => {
    if (typeof v === 'string') return seen.push(v === expected ? 'match' : 'mismatch');
    if (isObj(v)) {
      if (typeof v.equals === 'string')
        return seen.push(v.equals === expected ? 'match' : 'mismatch');
      if (Array.isArray(v.in) && v.in.length > 0 && Object.keys(v).length === 1) {
        return seen.push(v.in.every(x => x === expected) ? 'match' : 'mismatch');
      }
    }
    // anything else (`not`, `in` mixed with other operators, null, ...) proves nothing
    return undefined;
  };
  const visit = (w: Dict) => {
    for (const [k, v] of Object.entries(w)) {
      if (k === field) judge(v);
      else if (k === 'AND') {
        for (const member of Array.isArray(v) ? v : [v]) if (isObj(member)) visit(member);
      } else if (k.includes('_') && k.split('_').includes(field) && isObj(v)) {
        // compound unique input, e.g. storeId_slug: { storeId, slug }
        judge(v[field]);
      }
    }
  };
  visit(where);
  if (seen.includes('mismatch')) return 'mismatch';
  return seen.includes('match') ? 'match' : 'missing';
}

/** `where{id,storeId} data{...}`: the keys of the top-level args, for the error message. */
function argShape(args: unknown): string {
  if (!isObj(args)) return '';
  return Object.entries(args)
    .filter(([k]) => k === 'where' || k === 'data' || k === 'create')
    .map(
      ([k, v]) =>
        `${k}{${isObj(v) ? Object.keys(v).join(',') : Array.isArray(v) ? `[${v.length}]` : typeof v}}`
    )
    .join(' ');
}

/** The store a create row names: `storeId`, or `store: { connect: { id } }`. */
function dataStore(data: Dict): { named: boolean; value?: unknown } {
  if ('storeId' in data) return { named: true, value: data.storeId };
  const store = data.store;
  if (isObj(store) && isObj(store.connect) && 'id' in store.connect) {
    return { named: true, value: store.connect.id };
  }
  return { named: false };
}

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const DATA_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert']);
const KNOWN_OPS = new Set([...WHERE_OPS, ...CREATE_OPS, 'upsert']);

function rows(data: unknown): Dict[] {
  if (Array.isArray(data)) return data.filter(isObj);
  return isObj(data) ? [data] : [];
}

/**
 * Walk a write's `data` for nested writes into TENANT models: a storeId they name
 * must be the ambient store. A nested create that names none inherits its parent's
 * store (Prisma requires the FK otherwise), so it is not refused here.
 */
function checkNestedWrites(
  model: string,
  data: unknown,
  scope: AmbientScope,
  fail: (why: string) => never,
  depth = 0
): void {
  const m = modelMeta();
  if (depth > 8) return;
  for (const row of rows(data)) {
    const rel = m.relations.get(model);
    if (!rel) continue;
    for (const [field, value] of Object.entries(row)) {
      const target = rel.get(field);
      if (!target || !isObj(value)) continue;
      const nestedRows: unknown[] = [];
      for (const [verb, payload] of Object.entries(value)) {
        if (verb === 'create') nestedRows.push(payload);
        else if (verb === 'createMany' && isObj(payload)) nestedRows.push(payload.data);
        else if (verb === 'connectOrCreate') {
          for (const c of Array.isArray(payload) ? payload : [payload]) {
            if (isObj(c)) nestedRows.push(c.create);
          }
        } else if (verb === 'upsert') {
          for (const u of Array.isArray(payload) ? payload : [payload]) {
            if (isObj(u)) nestedRows.push(u.create, u.update);
          }
        } else if (verb === 'update' || verb === 'updateMany') {
          for (const u of Array.isArray(payload) ? payload : [payload]) {
            if (isObj(u)) nestedRows.push('data' in u && 'where' in u ? u.data : u);
          }
        }
      }
      for (const nested of nestedRows) {
        if (m.tenant.has(target)) {
          for (const r of rows(nested)) {
            const named = dataStore(r);
            if (named.named && named.value !== scope.storeId) {
              fail(`nested write into ${target} names another store`);
            }
          }
        }
        checkNestedWrites(target, nested, scope, fail, depth + 1);
      }
    }
  }
}

/**
 * Throw `TenantScopeViolation` unless `model.operation(args)` is scoped to `scope`.
 * Pure (no I/O); exported for the unit tests.
 */
export function assertTenantScoped(
  model: string,
  operation: string,
  args: unknown,
  scope: AmbientScope
): void {
  const fail = (why: string): never => {
    throw new TenantScopeViolation(model, operation, why, argShape(args));
  };
  if (scope.hatch === 'owner-role-tx') return;
  const m = modelMeta();
  const a = isObj(args) ? args : {};
  const isTenant = m.tenant.has(model);
  const isStore = model === STORE_MODEL;
  const isChild = m.child.has(model);
  const userKey = USER_KEYED_MODELS[model];
  if (userKey) {
    if (!KNOWN_OPS.has(operation)) fail(`unknown operation (the guard fails closed)`);
    if (scope.hatch === 'platform-operator') return;
    if (!scope.userId) fail('a user-keyed model needs an ambient user (withUser / userContext)');
    if (WHERE_OPS.has(operation) || operation === 'upsert') {
      if (keyVerdict(a.where, userKey, scope.userId) !== 'match') {
        fail(`where.${userKey} is not the ambient user`);
      }
    }
    if (CREATE_OPS.has(operation) || operation === 'upsert') {
      for (const r of operation === 'upsert' ? rows(a.create) : rows(a.data)) {
        const owner =
          r[userKey] ?? (isObj(r.user) && isObj(r.user.connect) ? r.user.connect.id : undefined);
        if (owner !== scope.userId) fail(`create does not set ${userKey} to the ambient user`);
      }
    }
    return;
  }
  if (!isTenant && !isStore && !isChild) {
    // Not tenant data (plans, tokens, settings): only nested tenant writes are checked.
    checkNestedWrites(model, a.data, scope, fail);
    return;
  }
  if (!KNOWN_OPS.has(operation)) fail(`unknown operation (the guard fails closed)`);

  if (isChild) {
    if (!scope.storeId) fail('a tenant child model needs an ambient store (no tenant context)');
    checkNestedWrites(model, a.data, scope, fail);
    return;
  }

  const operator = scope.hatch === 'platform-operator';

  if (isStore) {
    const byStore = scope.storeId ? keyVerdict(a.where, 'id', scope.storeId) : 'missing';
    const byOwner = scope.userId ? keyVerdict(a.where, 'ownerId', scope.userId) : 'missing';
    if (WHERE_OPS.has(operation) || operation === 'upsert') {
      if (byStore === 'mismatch' && !operator) fail(`where.id is not the ambient store`);
      if (byStore !== 'match' && byOwner !== 'match' && !operator) {
        fail(
          scope.storeId || scope.userId
            ? 'where is neither the ambient store (id) nor owned by the ambient user (ownerId)'
            : 'no tenant context: resolve the store through a SECURITY DEFINER function first'
        );
      }
    }
    if (CREATE_OPS.has(operation) || operation === 'upsert') {
      const creates = operation === 'upsert' ? rows(a.create) : rows(a.data);
      for (const r of creates) {
        const owner =
          r.ownerId ?? (isObj(r.owner) && isObj(r.owner.connect) ? r.owner.connect.id : undefined);
        if (!operator && (owner === undefined || owner !== scope.userId)) {
          fail('a new store must be owned by the ambient user');
        }
      }
    }
    checkNestedWrites(model, operation === 'upsert' ? [a.create, a.update] : a.data, scope, fail);
    return;
  }

  // TENANT (incl. identity) models
  const identityKey = IDENTITY_MODELS[model];
  const storeVerdict = (where: unknown): Verdict =>
    scope.storeId
      ? keyVerdict(where, 'storeId', scope.storeId)
      : keyVerdict(where, 'storeId', undefined);
  const userOk = (where: unknown): boolean =>
    Boolean(
      identityKey && scope.userId && keyVerdict(where, identityKey, scope.userId) === 'match'
    );

  if (WHERE_OPS.has(operation) || operation === 'upsert') {
    const v = storeVerdict(a.where);
    if (v === 'mismatch' && scope.storeId && !(identityKey && operator)) {
      fail('where.storeId is not the ambient store (cross-store access)');
    }
    if (v !== 'match' || !scope.storeId) {
      if (!(identityKey && (userOk(a.where) || operator))) {
        fail(
          scope.storeId
            ? 'where is not scoped to the ambient store (add storeId)'
            : 'no ambient store: run inside runInTenantContext / withStore / acrossStores'
        );
      }
    }
  }

  if (CREATE_OPS.has(operation) || operation === 'upsert') {
    const creates = operation === 'upsert' ? rows(a.create) : rows(a.data);
    for (const r of creates) {
      const named = dataStore(r);
      if (named.named && scope.storeId && named.value === scope.storeId) continue;
      if (identityKey) {
        // A row of the ambient store, the ambient user's own row, or the operator.
        if (operator) continue;
        const otherStore = named.named && named.value != null && named.value !== scope.storeId;
        if (otherStore) fail('create names another store');
        if (scope.userId && r[identityKey] === scope.userId) continue;
        fail('an identity row must belong to the ambient store or be the ambient user');
      }
      fail(
        named.named
          ? 'create names another store (or there is no ambient store)'
          : 'create does not set storeId to the ambient store'
      );
    }
  }

  if (DATA_OPS.has(operation)) {
    for (const d of operation === 'upsert' ? [a.update] : [a.data]) {
      for (const r of rows(d)) {
        const named = dataStore(r);
        if (named.named && named.value !== scope.storeId && !(identityKey && operator)) {
          fail('update moves a row to another store');
        }
      }
    }
  }

  checkNestedWrites(model, operation === 'upsert' ? [a.create, a.update] : a.data, scope, fail);
}

// ---------------------------------------------------------------------------
// Raw SQL (R-EBDA-004)
// ---------------------------------------------------------------------------

const TABLE_REF =
  /\b(?:from|join|into|update|using|table)\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;

/** The SQL text of a raw call's args: `$queryRawUnsafe(sql, ...)`, a template or `Prisma.sql`. */
export function rawSqlText(args: unknown): string {
  const first = Array.isArray(args) ? args[0] : args;
  if (typeof first === 'string') return first;
  if (isObj(first) || Array.isArray(first)) {
    const o = first as { strings?: unknown; sql?: unknown; text?: unknown; raw?: unknown };
    if (typeof o.sql === 'string') return o.sql;
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.strings)) return o.strings.join(' ? ');
    if (Array.isArray(first) && first.every(s => typeof s === 'string')) return first.join(' ? ');
    if (Array.isArray(o.raw)) return (o.raw as string[]).join(' ? ');
  }
  return '';
}

/** The guarded tables a statement names (lower case). */
export function guardedTablesIn(sql: string): string[] {
  const g = modelMeta().guardedTables;
  const hit = new Set<string>();
  for (const match of sql.matchAll(TABLE_REF)) {
    const t = match[1].toLowerCase();
    if (g.has(t)) hit.add(t);
  }
  return [...hit];
}

export function assertRawScoped(operation: string, args: unknown, scope: AmbientScope): void {
  if (scope.hatch === 'owner-role-tx' || scope.storeId || scope.userId) return;
  const sql = rawSqlText(args);
  if (!sql) {
    throw new TenantScopeViolation('$raw', operation, 'unreadable SQL with no tenant context');
  }
  const tables = guardedTablesIn(sql);
  if (tables.length > 0) {
    throw new TenantScopeViolation(
      '$raw',
      operation,
      `no tenant context, and the statement names tenant table(s) ${tables.join(', ')}; ` +
        'use a SECURITY DEFINER function or run inside withStore / acrossStores'
    );
  }
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

type QueryFn = (args: unknown) => Promise<unknown>;

/**
 * Optional per-query timing sink (API request hop timing, `x-hop-timing: 1`). Unset in every
 * other process; when set it only OBSERVES the duration of a query that the guard already
 * allowed, it never changes whether or how a query runs.
 */
let dbHopObserver: ((label: string, ms: number) => void) | undefined;
export function setDbHopObserver(fn: ((label: string, ms: number) => void) | undefined): void {
  dbHopObserver = fn;
}
function observed(label: string, run: () => Promise<unknown>): Promise<unknown> {
  const obs = dbHopObserver;
  if (!obs) return run();
  const t = performance.now();
  return run().finally(() => obs(label, performance.now() - t));
}

/**
 * Write observer: told AFTER a write to a watched model completed (in the caller's async context,
 * so `afterTenantTxCommit` / the request's deferral scope still apply). It only OBSERVES: it never
 * changes whether or how a query runs, and a throwing observer is swallowed. Used to emit
 * `store.plan_changed` from the ONE place every plan / subscription write passes through (any
 * service, job or route, present or future), instead of a call at each of ~25 write sites.
 */
export interface ModelWriteEvent {
  model: string;
  operation: string;
  args: unknown;
  result: unknown;
}
let modelWriteObserver: ((e: ModelWriteEvent) => void) | undefined;
export function setModelWriteObserver(fn: ((e: ModelWriteEvent) => void) | undefined): void {
  modelWriteObserver = fn;
}
const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);
/**
 * Tell the write observer about a write that did not go through the Prisma client extension: a D1-served model call
 * (services/platform/router.ts) or a raw D1 statement. The observer (Ebda Chat's `store.plan_changed`, catalog and
 * consent events) must see EVERY write whichever store holds the row.
 */
export function notifyModelWrite(
  model: string,
  operation: string,
  args: unknown,
  result: unknown
): void {
  observeWrite(model, operation, args, result);
}
function observeWrite(model: string, operation: string, args: unknown, result: unknown): void {
  const obs = modelWriteObserver;
  if (!obs || !WRITE_OPERATIONS.has(operation)) return;
  try {
    obs({ model, operation, args, result });
  } catch {
    /* an observer must never break a write that already succeeded */
  }
}

/**
 * The per-operation body of the extension: the guard check, the query, then the write observer.
 * Exported so the wiring is testable without a database.
 */
/**
 * NEON-ZERO-1 runtime guard: a model the API has moved to D1 must never reach THIS client (Postgres) once its family is
 * on D1; the router never calls the Postgres leg then, so any call that gets here bypassed the router (an unwrapped raw
 * transaction, a stray client). The API registers the predicate; it throws.
 */
let routedModelGuard: ((model: string, operation: string) => void) | undefined;
export function setRoutedModelGuard(
  fn: ((model: string, operation: string) => void) | undefined
): void {
  routedModelGuard = fn;
}

export function guardedOperation(p: {
  model: string;
  operation: string;
  args: unknown;
  query: QueryFn;
}): Promise<unknown> {
  const { model, operation, args, query } = p;
  routedModelGuard?.(model, operation);
  assertTenantScoped(model, operation, args, ambientScope());
  return observed(`db-${model}.${operation}`, () => query(args)).then(result => {
    observeWrite(model, operation, args, result);
    return result;
  });
}

/** The query extension the client factory installs on every app client. */
export const tenantGuardExtension = Prisma.defineExtension({
  name: 'ebda-tenant-guard',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        return guardedOperation({ model, operation, args, query: query as QueryFn });
      },
    },
    $queryRaw({ args, query }) {
      assertRawScoped('$queryRaw', args, ambientScope());
      return observed('db-raw', () => (query as QueryFn)(args));
    },
    $executeRaw({ args, query }) {
      assertRawScoped('$executeRaw', args, ambientScope());
      return observed('db-raw', () => (query as QueryFn)(args));
    },
    $queryRawUnsafe({ args, query }) {
      assertRawScoped('$queryRawUnsafe', args, ambientScope());
      return observed('db-raw', () => (query as QueryFn)(args));
    },
    $executeRawUnsafe({ args, query }) {
      assertRawScoped('$executeRawUnsafe', args, ambientScope());
      return observed('db-raw', () => (query as QueryFn)(args));
    },
  },
});
