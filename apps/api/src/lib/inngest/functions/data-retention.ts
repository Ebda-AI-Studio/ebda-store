import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { AuthService } from '../../../services/auth.service';
import logger from '../../logger';
import { inngest } from '../client';
import { auditLog } from '../../../middleware/security';

/**
 * Data retention crons (iceberg item #15 / Kuwait Law 13/2023 Art. 17:
 * "no longer than business need" + GDPR Art. 5(1)(e) storage limitation).
 *
 * Two passes:
 *
 *   1. abandoned-cart-purge — weekly. Drops AbandonedCart rows older
 *      than 30 days whose customerId is NULL (no logged-in customer
 *      attached). The cart's purpose is the 3-step recovery email
 *      sequence; after a month there's no business value left and
 *      the PII snapshot (customerEmail/customerPhone) needs to go.
 *
 *   2. soft-deleted-user-anonymize — monthly. For any customer User
 *      whose `deletedAt` is older than 12 months and whose row hasn't
 *      been anonymized yet, run the full eraseAccount transaction.
 *      Reuses the session-2b eraseAccount logic so a regulator audit
 *      gets the same anonymization shape regardless of whether the
 *      user clicked "delete account" or the cron caught up to them.
 *
 * Companion policy artifact: docs/RETENTION.md.
 */

const ABANDONED_CART_RETENTION_DAYS = 30;
const SOFT_DELETED_USER_RETENTION_DAYS = 365;

// Caps per run so a one-time historical backlog doesn't open
// thousands of Prisma transactions in a single tick.
const ABANDONED_CART_BATCH_CAP = 10_000;
const USER_ANONYMIZE_BATCH_CAP = 200;

export const abandonedCartPurge: InngestFunction.Any = inngest.createFunction(
  {
    id: 'abandoned-cart-purge-weekly',
    name: 'Purge anonymous abandoned carts older than 30 days',
    retries: 1,
    triggers: [{ cron: '0 4 * * 0' }],
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - ABANDONED_CART_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const candidateCount = await step.run('count-candidates', () =>
      prisma.abandonedCart.count({
        where: { createdAt: { lt: cutoff }, customerId: null },
      })
    );

    if (candidateCount === 0) {
      logger.info({ cutoff }, 'abandoned-cart-purge: nothing to purge');
      return { purged: 0 };
    }

    // deleteMany is server-side bulk; the BATCH_CAP throttles via `id`
    // window so a runaway backlog (e.g. first run after months of
    // missed schedules) doesn't lock the table for minutes.
    const deleted = await step.run('delete-batch', async () => {
      const candidates = await prisma.abandonedCart.findMany({
        where: { createdAt: { lt: cutoff }, customerId: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: ABANDONED_CART_BATCH_CAP,
      });
      if (candidates.length === 0) return 0;
      const result = await prisma.abandonedCart.deleteMany({
        where: { id: { in: candidates.map(c => c.id) } },
      });
      return result.count;
    });

    logger.info({ cutoff, candidateCount, deleted }, 'abandoned-cart-purge: completed');
    return { purged: deleted, remaining: candidateCount - deleted };
  }
);

export const softDeletedUserAnonymize: InngestFunction.Any = inngest.createFunction(
  {
    id: 'soft-deleted-user-anonymize-monthly',
    name: 'Anonymize customer users soft-deleted > 12 months ago',
    retries: 2,
    triggers: [{ cron: '0 2 1 * *' }],
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - SOFT_DELETED_USER_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // Already-erased rows have email `erased-<uuid>@anonymized.local`
    // (see AuthService.eraseAccount). Skip those — re-running the
    // erase transaction is idempotent but wastes a write per row.
    const candidates = await step.run('find-candidates', () =>
      prisma.user.findMany({
        where: {
          role: 'customer',
          deletedAt: { not: null, lt: cutoff },
          NOT: { email: { startsWith: 'erased-' } },
        },
        select: { id: true },
        take: USER_ANONYMIZE_BATCH_CAP,
      })
    );

    if (candidates.length === 0) {
      logger.info({ cutoff }, 'soft-deleted-user-anonymize: nothing to anonymize');
      return { anonymized: 0 };
    }

    let anonymized = 0;
    let failed = 0;
    for (const { id } of candidates) {
      // Each user gets its own step.run so a single failure doesn't
      // abort the whole batch — Inngest retries the failed step
      // independently per the function-level `retries: 2`.
      try {
        await step.run(`anonymize-${id}`, async () => {
          await AuthService.eraseAccount(id);
          await auditLog({
            action: 'user.account.anonymized_by_retention_cron',
            userId: id,
            resourceType: 'user',
            resourceId: id,
          });
        });
        anonymized += 1;
      } catch (err) {
        // Keep going — log the failure, leave the row for next month.
        failed += 1;
        logger.error(
          { err, userId: id, cutoff },
          'soft-deleted-user-anonymize: row failed, will retry next run'
        );
      }
    }

    logger.info(
      { cutoff, candidates: candidates.length, anonymized, failed },
      'soft-deleted-user-anonymize: completed'
    );
    return { anonymized, failed };
  }
);
