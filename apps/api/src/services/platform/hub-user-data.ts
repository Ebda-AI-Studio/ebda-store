/**
 * Everything a merchant / staff / admin USER leaves in the new storage, in one place (Ruling FOLD-ERASURE-1):
 *   D1 `ebda-platform`  classification-driven engine (cf/erasure/platform-subject.ts)
 *   StoreDO tables      actor ids (created_by, approved_by ...) replaced on every store (StoreDO.scrubActor)
 *   identity (D1)       eraseUser / exportUser on the accounts service (lib/identity-client.ts)
 * Customers are NOT handled here: their rows live in their store's DO and go through AuthService.eraseOnDo / exportOnDo.
 */
import { cfBindings } from '../../cf/bindings';
import {
  exportPlatformSubject,
  type D1Like,
  type PlatformSubject,
} from '../../cf/erasure/platform-subject';
import { AppError } from '../../middleware/error-handler';
import { inngest } from '../../lib/inngest/client';
import logger from '../../lib/logger';
import { doStoreIdList, storeDo } from '../../lib/store-backend';
import { eraseUserAccess } from './access-d1';

function platformDb(): D1Like {
  const d1 = (cfBindings() as { PLATFORM_DB?: D1Like } | undefined)?.PLATFORM_DB;
  if (!d1) throw new AppError(503, 'PLATFORM_DB_UNBOUND', 'Platform database is not bound');
  return d1;
}

/** Every platform-D1 row that is this user's (see exportPlatformSubject). */
export const exportHubUserPlatform = (s: PlatformSubject) => exportPlatformSubject(platformDb(), s);

const FANOUT = 8;

/** Replace the user's id on every actor column of every StoreDO. Idempotent; any store that fails fails the call (retry converges). */
export async function scrubUserActorOnStores(userId: string): Promise<{ stores: number }> {
  const ids = await doStoreIdList();
  const failed: string[] = [];
  for (let i = 0; i < ids.length; i += FANOUT)
    await Promise.all(
      ids.slice(i, i + FANOUT).map(async id => {
        try {
          await (
            storeDo(id) as unknown as { scrubActor(u: string): Promise<{ rows: number }> }
          ).scrubActor(userId);
        } catch (err) {
          logger.warn({ err, storeId: id }, '[erasure] store actor scrub failed');
          failed.push(id);
        }
      })
    );
  if (failed.length)
    throw new AppError(
      503,
      'ERASURE_STORES_INCOMPLETE',
      `Actor cleanup failed on ${failed.length} store(s), retry`
    );
  return { stores: ids.length };
}

/**
 * D1 rows + StoreDO actor ids of a hub user, after the identity account is gone. OneSignal device ids are captured BEFORE the rows
 * are deleted and handed to the `account/erased` propagation job, which removes them at the provider.
 */
export async function eraseHubUserData(s: PlatformSubject): Promise<void> {
  const devices = (
    await platformDb()
      .prepare('SELECT player_id FROM onesignal_subscriptions WHERE user_id = ?1')
      .bind(s.userId)
      .all<{ player_id: string }>()
  ).results;
  await eraseUserAccess(s.userId, s.email);
  await scrubUserActorOnStores(s.userId);
  await inngest
    .send({
      name: 'account/erased',
      data: { userId: s.userId, oneSignalPlayerIds: (devices ?? []).map(d => d.player_id) },
    })
    .catch(err =>
      logger.warn({ err, userId: s.userId }, '[erasure] account/erased enqueue failed')
    );
}
