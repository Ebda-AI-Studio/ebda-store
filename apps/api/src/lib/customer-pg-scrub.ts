/**
 * After a customer is erased in their StoreDO (N-9), the STALE Postgres copy of the same person (users row: email / name / phone /
 * password hash, refresh and verification tokens, passkeys) must go too, or the PII sits there until the Neon decommission
 * (Opus review of 7d03ec0cd, finding 2). Idempotent: re-running on an already-scrubbed or missing row is a no-op. If Postgres is
 * unreachable the scrub is ENQUEUED (jobs queue, `pg-copy-scrub`) and a P1 alert is raised; the queue retries with backoff and
 * dead-letters with a P1.
 */
import crypto from 'crypto';
import { Prisma, runInTenantContext, prisma } from '@ebda/database';
import { cfBindings } from '../cf/bindings';
import { postgresRemovedOnThisWorker } from './postgres-present';
import { deleteUserPasskeys, deleteUserTokens } from './definer';
import logger from './logger';
import { sendAlert } from '../services/alerts.service';

export interface PgCopyScrubMessage {
  kind: 'pg-copy-scrub';
  userId: string;
  storeId: string;
}
export const isPgCopyScrub = (v: unknown): v is PgCopyScrubMessage =>
  typeof v === 'object' &&
  v !== null &&
  (v as { kind?: unknown }).kind === 'pg-copy-scrub' &&
  typeof (v as { userId?: unknown }).userId === 'string' &&
  typeof (v as { storeId?: unknown }).storeId === 'string';

/** Scrub the Postgres copy. THROWS when Postgres cannot do it; `scrubOrEnqueue` is the caller-facing wrapper. */
export async function scrubPgCustomerCopy(
  userId: string,
  storeId: string
): Promise<{ scrubbed: boolean; skipped?: 'postgres-removed' }> {
  if (postgresRemovedOnThisWorker()) {
    logger.info(
      { userId, storeId },
      '[customer-erase] no Postgres on this Worker: nothing to scrub'
    );
    return { scrubbed: false, skipped: 'postgres-removed' };
  }
  return runInTenantContext(
    storeId,
    async () => {
      const row = await prisma.user.findFirst({
        where: { id: userId, storeId, role: 'customer' },
        select: { id: true },
      });
      if (!row) return { scrubbed: false };
      await prisma.user.update({
        where: { id: userId, storeId },
        data: {
          email: `erased-${userId}@anonymized.local`,
          firstName: 'Erased',
          lastName: 'User',
          phone: null,
          avatar: null,
          dateOfBirth: null,
          acquisition: Prisma.DbNull,
          passwordHash: crypto.randomBytes(32).toString('hex'),
          mfaEnabled: false,
          mfaSecret: null,
          mfaBackupCodes: [],
          mfaEnrolledAt: null,
          emailVerified: false,
          status: 'inactive',
          deletedAt: new Date(),
          tokenVersion: { increment: 1 },
        },
      });
      await deleteUserTokens(userId);
      await deleteUserPasskeys(userId);
      return { scrubbed: true };
    },
    userId
  );
}

/** Never throws: a failure is logged, alerted (P1) and queued for retry. */
export async function scrubOrEnqueue(
  userId: string,
  storeId: string,
  deps: {
    scrub?: typeof scrubPgCustomerCopy;
    enqueue?: (m: PgCopyScrubMessage) => Promise<void>;
    alert?: (a: { title: string; body: string }) => Promise<unknown>;
  } = {}
): Promise<{ scrubbed: boolean; enqueued: boolean }> {
  try {
    const r = await (deps.scrub ?? scrubPgCustomerCopy)(userId, storeId);
    return { scrubbed: r.scrubbed, enqueued: false };
  } catch (err) {
    logger.error({ err, userId, storeId }, '[customer-erase] Postgres copy scrub FAILED');
    let enqueued = false;
    try {
      await (
        deps.enqueue ??
        (async m => {
          const q = cfBindings()?.JOBS_QUEUE;
          if (!q) throw new Error('JOBS_QUEUE binding missing');
          await q.send(m, { contentType: 'json' });
        })
      )({ kind: 'pg-copy-scrub', userId, storeId });
      enqueued = true;
    } catch (e) {
      logger.error(
        { err: e, userId, storeId },
        '[customer-erase] pg-copy-scrub could not be enqueued'
      );
    }
    await Promise.resolve(
      (deps.alert ?? (a => sendAlert({ level: 'p1', source: 'customer.erase.pg_copy', ...a })))({
        title: 'Customer erased in the StoreDO but the Postgres copy still holds their data',
        body: `user ${userId} store ${storeId}: ${enqueued ? 'a retry is queued' : 'NO retry could be queued: scrub it by hand'}.`,
      })
    ).catch(() => undefined);
    return { scrubbed: false, enqueued };
  }
}
