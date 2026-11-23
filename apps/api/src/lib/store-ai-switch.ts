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
/** The store is suspended for billing (unpaid / over the store allowance): no AI spend until it is paid for (#836). */
export const AI_BILLING_SUSPENDED_CODE = 'AI_STORE_BILLING_SUSPENDED';
/** An admin-suspended store (or any non-active one) is refused AI spend. */
// pq-allow(unused-export): test seam, imported by tests/unit/ai-store-switch.test.ts
export const STORE_AI_SUSPENDED_CODE = 'STORE_AI_SUSPENDED';

/** The merchant switch, the billing suspension and the store's status in ONE uncached read (the never-stale gate); no row = fail closed. */
async function readAiGate(storeId: string) {
  // Through the store's backend (Ruling NZ-INTEG-1, NZ-AN-2): a DO store answers from its profile / D1 directory, never Postgres.
  return readInStoreContext(storeId, async () =>
    (await storeDb(storeId)).store.findUnique({
      where: { id: storeId },
      select: { aiFeaturesEnabled: true, status: true, billingSuspendedReason: true },
    })
  );
}

/** A store that cannot be read is NOT enabled: fail closed. This is the MERCHANT's switch only (what the AI settings page shows). */
export async function isStoreAiEnabled(storeId: string): Promise<boolean> {
  return (await readAiGate(storeId))?.aiFeaturesEnabled === true;
}

/**
 * The AI SPEND gate every AI spend passes (directly, through `assertAiQuota`, or through `requireAiEnabled`): the merchant's
 * switch is on, the store is not suspended for billing (#836: 402, pay from Billing), and the store is operational (Ruling
 * SUSPEND-AI-1: an admin-suspended store must not keep spending the platform's AI budget; unknown status = not operational,
 * fail closed). One primary-key read, uncached (NEVER-stale: a suspension or a restore is obeyed on the very next call).
 */
export async function assertStoreAiEnabled(storeId: string): Promise<void> {
  const row = await readAiGate(storeId);
  if (row?.aiFeaturesEnabled !== true) {
    throw new AppError(
      403,
      AI_DISABLED_BY_MERCHANT_CODE,
      'AI features are turned off for this store. Turn them on in AI tools.'
    );
  }
  if (row.billingSuspendedReason) {
    const en =
      'AI tools are paused until the subscription is paid. Pay from the Billing page to turn them back on.';
    throw new AppError(402, AI_BILLING_SUSPENDED_CODE, en, {
      messageEn: en,
      messageAr: 'الأدوات الذكية واقفة لحد ما الاشتراك يتدفع. ادفع من صفحة الفواتير وهترجع تشتغل.',
    });
  }
  if (!isStoreOperational(row.status))
    throw new AppError(
      403,
      STORE_AI_SUSPENDED_CODE,
      'This store is suspended, so AI features are paused. Contact support to get it reactivated.'
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
