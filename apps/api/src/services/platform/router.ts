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
import { setModelRouter, type ModelRouter } from '@ebda/database';
import { requirePlatformDb } from '../../lib/platform-db';
import { FAMILY_MODELS, assertFamilyNotFrozen, familyOfModel, platformFamilyOnD1 } from './cutover';

const WRITES: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

const MODELS: ReadonlySet<string> = new Set(Object.values(FAMILY_MODELS).flat());

export const platformRouter: ModelRouter = {
  models: MODELS,
  async route(model, method, args, postgres) {
    const family = familyOfModel(model);
    if (!family) return postgres();
    if (!(await platformFamilyOnD1(family))) {
      if (WRITES.has(method)) await assertFamilyNotFrozen(family);
      return postgres();
    }
    const client = await requirePlatformDb();
    return (client[model] as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](
      ...args
    );
  },
};

export function registerPlatformRouter(): void {
  setModelRouter(platformRouter);
}

registerPlatformRouter();
