/**
 * NEON-ZERO-1 (N-10): registers the model router on the `prisma` proxy of @ebda/database. After a family's cutover
 * marker exists (services/platform/cutover.ts) every `prisma.<model>.*` / `withStore` transaction call for a model of
 * that family is answered by D1; before it, by Postgres unchanged. Import this module once at boot (app.ts).
 *
 * D1 has no interactive transaction: a callback that wrote several tables in one Postgres transaction now issues
 * single statements. Every write path that relied on the transaction for atomicity is listed in
 * docs/plans/2026-11-02-neon-zero.md section N-10 (Ruling NZ-10-2) with the replacement (one atomic statement, `$batch`,
 * a compare-and-set, or a compensating write).
 */
import {
  prisma,
  notifyModelWrite,
  setModelRouter,
  setRoutedModelGuard,
  setPlatformOperatorVerifier,
  type ModelRouter,
} from '@ebda/database';
import { requirePlatformDb } from '../../lib/platform-db';
import { cfBindings } from '../../cf/bindings';
import { getAccountState } from '../../lib/identity-client';
import { D1_FIELDS } from '../../lib/store-columns';
import {
  FAMILY_MODELS,
  familyOfModel,
  platformFamilyOnD1,
  platformFamilyOnD1ForWrite,
  isFamilyCachedOnD1,
  type PlatformFamily,
} from './cutover';
import { AppError } from '../../middleware/error-handler';
import { storeRepo } from '../../lib/repo-factory';
import { hubOnD1 } from '../../lib/platform-hub';
import { d1All } from './billing-d1';

const WRITES = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/** The platform VAT setting key (Ruling TAX-6/TAX-8): only an active super_admin may change it. */
const PLATFORM_VAT_KEY = 'ebda.vat';

/**
 * Postgres enforces TAX-8 with the trigger `system_settings_platform_vat_guard` (only an active super_admin writes
 * `ebda.vat`). On D1 there is no trigger, so the router enforces the same rule on the same signal: the acting user the
 * request already carries (`ebda_is_super_admin()` reads `app.current_user_id`, identity still lives in Postgres).
 * Replaceable in tests.
 */
export const vatGuard = {
  isSuperAdmin: async (): Promise<boolean> => {
    const rows = await prisma.$queryRaw<
      Array<{ ok: boolean }>
    >`SELECT public.ebda_is_super_admin() AS ok`;
    return rows[0]?.ok === true;
  },
};

/** Does this write name `ebda.vat`, or could it (a bulk write whose key filter is not a literal)? Conservative. */
function touchesPlatformVat(method: string, arg: unknown): boolean {
  const a = (arg ?? {}) as { where?: { key?: unknown } };
  if (JSON.stringify(arg ?? null).includes(PLATFORM_VAT_KEY)) return true;
  return (method === 'updateMany' || method === 'deleteMany') && typeof a.where?.key !== 'string';
}

const MODELS: ReadonlySet<string> = new Set([...Object.values(FAMILY_MODELS).flat(), 'store']);

/**
 * `Store` is split between D1 `stores` (the directory + mirror columns, D1_FIELDS) and the Durable Object. A READ that
 * names ONLY directory columns (select / where / orderBy) is answered by D1 once the access family is there (D1 `stores` is
 * the directory of record); anything that needs a DO column, a relation or a whole row stays on its Postgres path.
 */
const STORE_READS = new Set(['findUnique', 'findFirst', 'findMany', 'count']);
function onlyDirectoryColumns(where: unknown): boolean {
  if (where === undefined || where === null) return true;
  if (typeof where !== 'object') return false;
  return Object.entries(where as Record<string, unknown>).every(([k, v]) =>
    k === 'AND' || k === 'OR' || k === 'NOT'
      ? (Array.isArray(v) ? v : [v]).every(onlyDirectoryColumns)
      : D1_FIELDS.has(k)
  );
}
function storeReadServedByD1(method: string, arg: unknown): boolean {
  if (!STORE_READS.has(method)) return false;
  const a = (arg ?? {}) as {
    where?: unknown;
    select?: Record<string, unknown>;
    include?: unknown;
    orderBy?: unknown;
  };
  if (a.include) return false;
  if (method !== 'count') {
    if (!a.select) return false;
    if (!Object.entries(a.select).every(([k, v]) => !v || D1_FIELDS.has(k))) return false;
  }
  const orderBy = Array.isArray(a.orderBy) ? a.orderBy : a.orderBy ? [a.orderBy] : [];
  if (!orderBy.every(o => Object.keys(o as object).every(k => D1_FIELDS.has(k)))) return false;
  return onlyDirectoryColumns(a.where);
}

/**
 * Ruling NZ-C-15: `prisma.store.<read>({ where: { id } })` for a store served by its Durable Object is answered by that DO (the
 * Postgres `stores` row of a DO store is sealed and, once Postgres is gone, does not exist). ~190 service call sites read the
 * store this way inside `withStore`; routing them here fixes the class instead of porting each. A Postgres store (and every
 * call without a literal id, or a write) goes to Postgres exactly as before. A store with no directory row is Postgres until
 * the platform families move, and `null` after (a real 404, never a Postgres connection). `include` of a relation the DO cannot
 * join throws its own clear error. Cost if wrong: a caller that relied on a stale Postgres row of a DO store now reads the DO.
 */
const DO_STORE_READS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** D1 `stores` column of each Store field a by-owner list may select (anything else is refused loudly, never read from Postgres). */
const OWNER_LIST_COLS: Record<string, string> = {
  id: 'id',
  name: 'name',
  nameAr: 'name_ar',
  slug: 'slug',
  domain: 'domain',
  status: 'status',
  plan: 'plan',
  ownerId: 'owner_id',
  createdAt: 'created_at',
  billingSuspendedReason: 'billing_suspended_reason',
  isDemo: 'is_demo',
};

async function routeStoreOwnerList(method: string, args: unknown[]): Promise<unknown> {
  const a = (args[0] ?? {}) as {
    where?: { ownerId?: unknown; deletedAt?: unknown };
    select?: Record<string, boolean>;
    take?: number;
  };
  const owner = a.where?.ownerId;
  if (typeof owner !== 'string' || a.where?.deletedAt !== null)
    throw new AppError(501, 'STORE_READ_UNSUPPORTED', 'This store list is not served by D1');
  if (method === 'count') {
    const r = await d1All<{ n: number }>(
      'SELECT COUNT(*) AS n FROM stores WHERE owner_id = ?1 AND deleted_at IS NULL',
      owner
    );
    return Number(r[0]?.n ?? 0);
  }
  const keys = Object.entries(a.select ?? { id: true })
    .filter(([, v]) => v)
    .map(([k]) => k);
  const bad = keys.filter(k => !(k in OWNER_LIST_COLS));
  if (bad.length)
    throw new AppError(
      501,
      'STORE_READ_UNSUPPORTED',
      `Store field(s) not served by D1: ${bad.join(', ')}`
    );
  const rows = await d1All<Record<string, unknown>>(
    `SELECT ${keys.map(k => `${OWNER_LIST_COLS[k]} AS ${k}`).join(', ')} FROM stores WHERE owner_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC, id LIMIT ${Math.min(Math.max(a.take ?? 200, 1), 500)}`,
    owner
  );
  return rows.map(r => {
    const o: Record<string, unknown> = { ...r };
    if ('createdAt' in o) o.createdAt = new Date(Number(o.createdAt));
    if ('isDemo' in o) o.isDemo = Number(o.isDemo) === 1;
    return o;
  });
}

async function routeStoreRead(
  method: string,
  args: unknown[],
  postgres: () => Promise<unknown>
): Promise<unknown> {
  // Before the platform families move, every Store read is Postgres exactly as before (callers such as the store delete test
  // for the Postgres row's existence on purpose).
  if (!(await hubOnD1())) return postgres();
  if (method === 'findMany' || method === 'count') {
    const w = (args[0] as { where?: { ownerId?: unknown } } | undefined)?.where;
    return typeof w?.ownerId === 'string' ? routeStoreOwnerList(method, args) : postgres();
  }
  const id = (args[0] as { where?: { id?: unknown } } | undefined)?.where?.id;
  if (!DO_STORE_READS.has(method) || typeof id !== 'string' || !UUID.test(id)) return postgres();
  let repo;
  try {
    repo = await storeRepo(id);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      if (method.endsWith('OrThrow')) throw err;
      return null;
    }
    throw err;
  }
  if (repo.backend !== 'do') return postgres();
  return (repo.db.store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
    method
  ](...args);
}

/**
 * A family that must not be on D1 unless another one already is. `payments` (claims, receipts) is confirmed inside the
 * billing ledger flow: with the claim on D1 and the ledger still on Postgres, a Postgres rollback would leave a claim
 * `confirmed` against an event that does not exist. The copy script refuses the same order; this makes the code refuse it
 * too (fail closed, retryable 503) if the markers are ever set out of order by hand.
 */
export const FAMILY_REQUIRES: Partial<Record<PlatformFamily, PlatformFamily>> = {
  payments: 'billing',
};
async function assertFamilyOrder(family: PlatformFamily): Promise<void> {
  const need = FAMILY_REQUIRES[family];
  if (need && !(await platformFamilyOnD1(need)))
    throw new AppError(
      503,
      'PLATFORM_FAMILY_ORDER',
      `${family} is on D1 but ${need} is not: refusing to serve a split money flow`,
      { retryable: true, family }
    );
}

export const platformRouter: ModelRouter = {
  models: MODELS,
  async route(model, method, args, postgres) {
    if (model === 'store') {
      if (
        storeReadServedByD1(method, args[0]) &&
        cfBindings()?.PLATFORM_DB &&
        (await platformFamilyOnD1('access'))
      ) {
        const client = await requirePlatformDb();
        return (client.store as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](
          ...args
        );
      }
      return routeStoreRead(method, args, postgres);
    }
    const family = familyOfModel(model);
    if (!family) return postgres();
    const onD1 = WRITES.has(method)
      ? await platformFamilyOnD1ForWrite(family)
      : await platformFamilyOnD1(family);
    if (!onD1) return postgres();
    if (model === 'systemSetting' && WRITES.has(method) && touchesPlatformVat(method, args[0])) {
      if (!(await vatGuard.isSuperAdmin()))
        throw new AppError(
          403,
          'PLATFORM_VAT_FORBIDDEN',
          'ebda.vat: only a super_admin may change the platform VAT setting'
        );
    }
    await assertFamilyOrder(family);
    const client = await requirePlatformDb();
    const result = await (client[model] as Record<string, (...a: unknown[]) => Promise<unknown>>)[
      method
    ](...args);
    // The Postgres client extension reports every write to the write observer (Ebda Chat plan / catalog events);
    // a D1-served write must do the same or those events silently stop.
    if (WRITES.has(method))
      notifyModelWrite(model[0].toUpperCase() + model.slice(1), method, args[0], result);
    return result;
  },
};

export function registerPlatformRouter(): void {
  setModelRouter(platformRouter);
  // A call that reaches the POSTGRES client for a model whose family this isolate knows is on D1 bypassed the router
  // (NEON-ZERO-1 runtime guard; the registration was dropped by a merge, tests/unit/platform-billing-d1-money.test.ts).
  setRoutedModelGuard((model, operation) => {
    const camel = model[0].toLowerCase() + model.slice(1);
    const family = MODELS.has(camel) ? familyOfModel(camel) : undefined;
    if (family && isFamilyCachedOnD1(family))
      throw new Error(
        `ROUTED_MODEL_ON_POSTGRES: ${model}.${operation} reached Postgres after ${family} moved to D1 (a raw transaction that was not wrapped with routeTx?)`
      );
  });
  // The identity service decides "an ACTIVE super_admin" (Rulings ID-1/ID-2) where it is bound: no Postgres round trip.
  setPlatformOperatorVerifier(async userId => {
    if (!cfBindings()?.ACCOUNTS) return undefined;
    const a = await getAccountState(userId);
    return !!a && a.status === 'active' && a.role === 'super_admin';
  });
  // The scope resolver (withStore / withUser / acrossStores without a request transaction) is registered once in
  // lib/store-scope-resolver.ts (Ruling NZ-INTEG-1).
}

registerPlatformRouter();
