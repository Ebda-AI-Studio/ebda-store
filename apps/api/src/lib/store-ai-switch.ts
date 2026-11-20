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
import { prisma } from '@ebda/database';
import { storeDb, storeUpdate } from './repo-factory';
import { AppError } from '../middleware/error-handler';
import { readInStoreContext } from './store-scoped-read';
import { isStoreOperational } from './store-operational';

export const AI_DISABLED_BY_MERCHANT_CODE = 'AI_DISABLED_BY_MERCHANT';
/** An admin-suspended store (or any non-active one) is refused AI spend. */
export const STORE_AI_SUSPENDED_CODE = 'STORE_AI_SUSPENDED';

/** The merchant switch and the store's status in ONE uncached read (the never-stale gate); no row = both fail closed. */
async function readAiGate(
  storeId: string
): Promise<{ aiFeaturesEnabled: boolean; status: string | null }> {
  // Through the store's backend (Ruling NZ-INTEG-1, NZ-AN-2): a DO store answers from its profile / D1 directory, never Postgres.
  const row = await readInStoreContext(storeId, async () =>
    (await storeDb(storeId)).store.findUnique({
      where: { id: storeId },
      select: { aiFeaturesEnabled: true, status: true },
    })
  );
  return { aiFeaturesEnabled: row?.aiFeaturesEnabled === true, status: row?.status ?? null };
}

/** A store that cannot be read is NOT enabled: fail closed. This is the MERCHANT's switch only (what the AI settings page shows). */
export async function isStoreAiEnabled(storeId: string): Promise<boolean> {
  return (await readAiGate(storeId)).aiFeaturesEnabled;
}

/**
 * The AI SPEND gate: the merchant's switch AND the store being operational. A store an admin suspended must not keep spending the
 * platform's AI budget (Ruling SUSPEND-AI-1): interactive routes, bulk sweeps and the autopilot all pass here through `assertAiQuota` /
 * `requireAiEnabled`. Status is read uncached with the switch (NEVER-stale: a suspension is obeyed on the very next call); an
 * unknown status is not operational (fail closed).
 */
export async function assertStoreAiEnabled(storeId: string): Promise<void> {
  const gate = await readAiGate(storeId);
  if (!isStoreOperational(gate.status))
    throw new AppError(
      403,
      STORE_AI_SUSPENDED_CODE,
      'This store is suspended, so AI features are paused. Contact support to get it reactivated.'
    );
  if (gate.aiFeaturesEnabled) return;
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

/**
 * Flips the merchant's AI switch. The one writer: `PUT /stores/:storeId/ai/settings` (routes/ai.routes.ts) and the assistant's `ai_switch_set`
 * tool both call it, so the two cannot drift.
 */
export async function setStoreAiEnabled(storeId: string, enabled: boolean): Promise<void> {
  await storeUpdate(prisma, { where: { id: storeId }, data: { aiFeaturesEnabled: enabled } });
}
