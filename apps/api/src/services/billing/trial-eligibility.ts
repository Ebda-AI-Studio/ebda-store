/**
 * One signup trial per owner, deleted stores included (R-TRIAL-ONCE-1).
 *
 * A store delete is a HARD delete (StoreService.delete removes the row, and the owner's profile with it when it was the last
 * store), so "count the owner's stores including deleted ones" has nothing left to count. The trial is therefore recorded when
 * it starts, in `system_settings` (platform-global, no store_id, survives every store/user delete) under a key derived from
 * the owner's NORMALISED EMAIL: a delete-and-recreate that also re-registers the same address is still the same owner.
 * Only a sha256 of the address is stored, never the address.
 */
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';
import logger from '../../lib/logger';

const PREFIX = 'ebda.trial-used:';

function trialUsedKey(email: string): string {
  return PREFIX + crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** True when a signup trial was already started for this owner (any store, live or deleted). */
export async function ownerHasUsedTrial(email: string): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: trialUsedKey(email) },
    select: { id: true },
  });
  return !!row;
}

/**
 * Record that this owner's signup trial started. Called AFTER the store (and its trial) committed: a failure here must not
 * fail a store that already exists, so it is logged loudly and the next create would re-grant a trial (residual window).
 */
export async function markOwnerTrialUsed(email: string, storeId: string): Promise<void> {
  try {
    await prisma.systemSetting.upsert({
      where: { key: trialUsedKey(email) },
      create: {
        key: trialUsedKey(email),
        value: { storeId, at: new Date().toISOString() },
        category: 'billing',
        isPublic: false,
      },
      update: {},
    });
  } catch (err) {
    logger.error({ err, storeId }, '[trial] could not record the used signup trial');
  }
}
