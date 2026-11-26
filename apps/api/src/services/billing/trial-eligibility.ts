/**
 * One signup trial per owner, deleted stores included (R-TRIAL-ONCE-1).
 *
 * A store delete is a HARD delete (StoreService.delete removes the row, and the owner's profile with it when it was the last
 * store), so "count the owner's stores including deleted ones" has nothing left to count. The trial is therefore recorded when
 * it starts, in `system_settings` (platform-global, no store_id, survives every store/user delete) under a key derived from
 * the owner's NORMALISED EMAIL (`normalizeTrialEmail`: `+tag` and Gmail dots and googlemail.com fold to one mailbox): a delete-and-recreate that also re-registers the same address, or an alias of it, is still the same owner.
 * Markers written before the normalisation used the plain lowercased address; lookups check both keys, writes use the new one.
 * Only a sha256 of the address is stored, never the address.
 */
import crypto from 'node:crypto';
import { withUser } from '@ebda/database';
import { platformDb } from '../../lib/platform-db';
import logger from '../../lib/logger';
import { getAccountState } from '../../lib/identity-client';
import { onAccessD1 } from '../platform/access-d1';

const PREFIX = 'ebda.trial-used:';

const keyOf = (address: string): string =>
  PREFIX + crypto.createHash('sha256').update(address).digest('hex');

/**
 * The address a trial is counted against: the SAME mailbox must give the same string however it is typed (the trial is one per
 * owner, and a fresh free trial per alias defeats it). Lowercase and trim; drop a `+tag` from the local part on every domain;
 * on Gmail also drop the dots in the local part and read googlemail.com as gmail.com (both reach one mailbox). A local part that
 * would become empty keeps its original form, so `+x@` aliases do not all collapse together.
 */
// pq-allow(unused-export): a test seam, tests/unit/trial-eligibility.test.ts pins the alias folding on the pure function
export function normalizeTrialEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  const original = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  let local = original.split('+')[0]!;
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local || original}@${domain}`;
}

/** The marker key written from now on (normalised address). */
function trialUsedKey(email: string): string {
  return keyOf(normalizeTrialEmail(email));
}
/** The key markers were written under before normalisation (trim + lowercase only): still honoured on lookup, never written. */
function legacyTrialUsedKey(email: string): string {
  return keyOf(email.trim().toLowerCase());
}

async function markerExists(
  db: NonNullable<Awaited<ReturnType<typeof platformDb>>>,
  email: string
): Promise<boolean> {
  const keys = [...new Set([trialUsedKey(email), legacyTrialUsedKey(email)])];
  for (const key of keys) {
    const row = await db.systemSetting.findUnique({ where: { key }, select: { id: true } });
    if (row) return true;
  }
  return false;
}

/** True when a signup trial was already started for this owner (any store, live or deleted). */
export async function ownerHasUsedTrial(email: string): Promise<boolean> {
  // SystemSetting is a D1 model (model-split.json): read through the platform D1 client. No binding (Node / unit tests)
  // = no marker store, so no block.
  const db = await platformDb();
  if (!db) return false;
  return markerExists(db, email);
}

/**
 * CLAIM the owner's one signup trial BEFORE the store is created: ONE atomic insert-or-skip of the marker row (a unique
 * `system_settings.key`; `createMany ... skipDuplicates` is one D1 statement, `count > 0` only for the request that created it).
 * Only that request grants the trial, so two concurrent first-store creates (or a create racing an onboarding) can never both
 * get one: the read-then-write it replaces let both pass the read.
 *  - `owned`: THIS request created the marker, so a failed store create must give it back (`releaseOwnerTrial`).
 *  - `grant`: the trial may be granted. False when another request / an earlier store already used it.
 * A marker store that cannot be read or written (`platformDb()` absent, D1 error) is logged and does NOT block the merchant:
 * `grant: true, owned: false` (fails in the merchant's favour; Ruling R-TRIAL-ONCE-1, the residual window is one extra trial
 * while D1 is down, never a lost store). Nothing here is retried.
 */
export async function claimOwnerTrial(email: string): Promise<{ grant: boolean; owned: boolean }> {
  try {
    const db = await platformDb();
    if (!db) return { grant: true, owned: false };
    // a marker written under the OLD key (before normalisation) still counts: this owner already had their trial
    const legacy = legacyTrialUsedKey(email);
    if (legacy !== trialUsedKey(email)) {
      const old = await db.systemSetting.findUnique({
        where: { key: legacy },
        select: { id: true },
      });
      if (old) return { grant: false, owned: false };
    }
    const { count } = await db.systemSetting.createMany({
      data: [
        {
          key: trialUsedKey(email),
          value: { at: new Date().toISOString() },
          category: 'billing',
          isPublic: false,
        },
      ],
      skipDuplicates: true,
    });
    return count > 0 ? { grant: true, owned: true } : { grant: false, owned: false };
  } catch (err) {
    logger.error(
      { err },
      '[trial] could not claim the signup trial marker; granting (fails in the merchant favour)'
    );
    return { grant: true, owned: false };
  }
}

/** Give back a marker THIS request created, when the store it was claimed for was never created. Never throws. */
export async function releaseOwnerTrial(email: string): Promise<void> {
  try {
    const db = await platformDb();
    if (!db) return;
    await db.systemSetting.deleteMany({ where: { key: trialUsedKey(email) } });
  } catch (err) {
    logger.error(
      { err },
      '[trial] could not release the signup trial marker after a failed store create'
    );
  }
}

/**
 * The owner's email, from the identity service once `access` is on D1 (there is no Postgres `users` read then), else Postgres.
 * Fails CLOSED for the trial only: an unreadable account (`unknown: true`) gets NO trial, and the store is still created
 * (unpaid, payment required before go-live). Logs the owner id only, never the address.
 */
export async function ownerEmailOf(ownerId: string): Promise<{ email?: string; unknown: boolean }> {
  try {
    const email = (await onAccessD1())
      ? ((await getAccountState(ownerId))?.email ?? undefined)
      : (
          await withUser(ownerId, tx =>
            tx.user.findUnique({ where: { id: ownerId }, select: { email: true } })
          )
        )?.email;
    if (email) return { email, unknown: false };
    logger.warn({ ownerId }, '[trial] owner email not found; no trial granted');
    return { unknown: true };
  } catch (err) {
    logger.warn({ err, ownerId }, '[trial] owner email unreadable; no trial granted');
    return { unknown: true };
  }
}
