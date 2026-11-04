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
import { AppError } from '../../middleware/error-handler';
import {
  prisma,
  notifyModelWrite,
  setModelRouter,
  setRoutedModelGuard,
  type ModelRouter,
} from '@ebda/database';
import { requirePlatformDb } from '../../lib/platform-db';
import {
  FAMILY_MODELS,
  familyOfModel,
  platformFamilyOnD1,
  platformFamilyOnD1ForWrite,
  isFamilyCachedOnD1,
} from './cutover';

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

const MODELS: ReadonlySet<string> = new Set(Object.values(FAMILY_MODELS).flat());

export const platformRouter: ModelRouter = {
  models: MODELS,
  async route(model, method, args, postgres) {
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
  // A call that reaches the POSTGRES client for a model whose family this isolate knows is on D1 bypassed the router.
  setRoutedModelGuard((model, operation) => {
    const camel = model[0].toLowerCase() + model.slice(1);
    const family = MODELS.has(camel) ? familyOfModel(camel) : undefined;
    if (family && isFamilyCachedOnD1(family))
      throw new Error(
        `ROUTED_MODEL_ON_POSTGRES: ${model}.${operation} reached Postgres after ${family} moved to D1 (a raw transaction that was not wrapped with routeTx?)`
      );
  });
}

registerPlatformRouter();
