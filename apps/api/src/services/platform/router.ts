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
      return postgres();
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
