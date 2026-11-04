/**
 * The merchant's AI switch: `stores.ai_features_enabled` (default ON). Off means no AI call for that store from
 * ANY entry point: an interactive route, a bulk sweep, the autopilot, a campaign draft.
 *
 * One function answers it (`assertStoreAiEnabled`). `assertAiQuota` asks it before it counts anything, so every
 * call site that already budgets its AI spend is covered without edits; `requireAiEnabled` is the HTTP guard for
 * routers (a cached translation never reaches `assertAiQuota`, so the router must refuse it too).
 * `tests/unit/ai-entry-points-respect-switch.test.ts` fails when a new entry point skips both.
 *
 * Staleness class: NEVER-stale (a permission). No cache: one primary-key read per AI call, which is noise next to a
 * model round trip, so a merchant who flips it off is obeyed on the very next call.
 */
import type { NextFunction, Request, Response } from 'express';
import { storeDb } from './repo-factory';
import { AppError } from '../middleware/error-handler';
import { readInStoreContext } from './store-scoped-read';

export const AI_DISABLED_BY_MERCHANT_CODE = 'AI_DISABLED_BY_MERCHANT';

/** A store that cannot be read is NOT enabled: fail closed. */
export async function isStoreAiEnabled(storeId: string): Promise<boolean> {
  // Through the store's backend (Ruling NZ-INTEG-1, NZ-AN-2): a DO store answers from its profile / D1 directory, never Postgres.
  const row = await readInStoreContext(storeId, async () =>
    (await storeDb(storeId)).store.findUnique({
      where: { id: storeId },
      select: { aiFeaturesEnabled: true },
    })
  );
  return row?.aiFeaturesEnabled === true;
}

export async function assertStoreAiEnabled(storeId: string): Promise<void> {
  if (await isStoreAiEnabled(storeId)) return;
  throw new AppError(
    403,
    AI_DISABLED_BY_MERCHANT_CODE,
    'AI features are turned off for this store. Turn them on in AI tools.'
  );
}

export async function requireAiEnabled(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const storeId = req.params?.storeId ?? (req as { storeId?: string }).storeId;
    if (!storeId)
      throw new AppError(400, 'STORE_REQUIRED', 'A store is required for this request.');
    await assertStoreAiEnabled(storeId);
    next();
  } catch (error) {
    next(error);
  }
}
