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

const MODELS: ReadonlySet<string> = new Set(Object.values(FAMILY_MODELS).flat());

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
    const family = familyOfModel(model);
    if (!family) return postgres();
    const onD1 = WRITES.has(method)
      ? await platformFamilyOnD1ForWrite(family)
      : await platformFamilyOnD1(family);
    if (!onD1) return postgres();
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
