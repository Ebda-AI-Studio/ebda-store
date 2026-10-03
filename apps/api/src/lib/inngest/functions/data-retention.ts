import type { InngestFunction } from 'inngest';
import { prisma, withRlsBypass } from '@force/database';
import { AuthService, eraseNeedsCrmReview } from '../../../services/auth.service';
import logger from '../../logger';
import { inngest } from '../client';
import { auditLog } from '../../../middleware/security';

/**
 * Data retention crons (iceberg item #15 / applicable GCC data-protection
 * law's "no longer than business need" principle + GDPR Art. 5(1)(e)
 * storage limitation — see docs/legal/gcc-data-protection.md).
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
// Egypt MOF tax record retention is 5 years from invoice issue.
// After that the order row is no longer required for tax compliance
// and its PII snapshots (already nullified at customer-erase time,
// but not for orders whose customer never asked to be erased) need
// to be scrubbed under applicable GCC data-protection law's storage
// limitation principle (see docs/legal/gcc-data-protection.md).
const ORDER_ANONYMIZE_RETENTION_DAYS = 365 * 5; // 1825 days

// Caps per run so a one-time historical backlog doesn't open
// thousands of Prisma transactions in a single tick.
const ABANDONED_CART_BATCH_CAP = 10_000;
const USER_ANONYMIZE_BATCH_CAP = 200;
const ORDER_ANONYMIZE_BATCH_CAP = 500;

export const abandonedCartPurge: InngestFunction.Any = inngest.createFunction(
  {
    id: 'abandoned-cart-purge-weekly',
    name: 'Purge anonymous abandoned carts older than 30 days',
    retries: 1,
    triggers: [{ cron: '0 4 * * 0' }],
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - ABANDONED_CART_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // FORCE RLS: data-retention is cross-tenant — no storeId available.
    // Use withRlsBypass for all DB operations in this cron.
    const candidateCount = await step.run('count-candidates', () =>
      withRlsBypass(tx =>
        tx.abandonedCart.count({
          where: { createdAt: { lt: cutoff }, customerId: null },
        })
      )
    );

    if (candidateCount === 0) {
      logger.info({ cutoff }, 'abandoned-cart-purge: nothing to purge');
      return { purged: 0 };
    }

    // deleteMany is server-side bulk; the BATCH_CAP throttles via `id`
    // window so a runaway backlog (e.g. first run after months of
    // missed schedules) doesn't lock the table for minutes.
    const deleted = await step.run('delete-batch', () =>
      withRlsBypass(async tx => {
        const candidates = await tx.abandonedCart.findMany({
          where: { createdAt: { lt: cutoff }, customerId: null },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: ABANDONED_CART_BATCH_CAP,
        });
        if (candidates.length === 0) return 0;
        const result = await tx.abandonedCart.deleteMany({
          where: { id: { in: candidates.map(c => c.id) } },
        });
        return result.count;
      })
    );

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
    // FORCE RLS: cross-tenant cron — use withRlsBypass throughout.
    const candidates = await step.run('find-candidates', () =>
      withRlsBypass(tx =>
        tx.user.findMany({
          where: {
            role: 'customer',
            deletedAt: { not: null, lt: cutoff },
            NOT: { email: { startsWith: 'erased-' } },
          },
          select: { id: true },
          take: USER_ANONYMIZE_BATCH_CAP,
        })
      )
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
          // Retention erasure spans every store (Ruling W-7); actor is 'system'.
          const outcome = await AuthService.eraseAccount(id, { actorId: 'system' });
          await auditLog({
            action: 'user.account.anonymized_by_retention_cron',
            userId: id,
            resourceType: 'user',
            resourceId: id,
            // #1880: record whether the merchant-CRM copy was scrubbed.
            details: { ...outcome, crmReviewNeeded: eraseNeedsCrmReview(outcome) },
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

/**
 * Order anonymization at 5 years.
 *
 * Egypt MOF requires invoice retention ≥5 years for tax compliance.
 * After that window the order ROW can still survive (financial record)
 * but its PII snapshots must go (applicable GCC data-protection law +
 * GDPR Art. 5(1)(e) storage limitation — see
 * docs/legal/gcc-data-protection.md).
 *
 * The eraseAccount path already scrubs orders' shipping/billing JSON
 * to `{ anonymized: true }` and nulls customerId AT CUSTOMER-ERASE TIME.
 * But orders whose customer NEVER asked to be erased (most cases) keep
 * their PII forever without this cron.
 *
 * Candidate: order.createdAt < now - 5y AND shippingAddress NOT already
 * `{anonymized:true}` (idempotent — re-runs skip already-scrubbed rows).
 * No-op until the first orders age into the 5y window (earliest FWB
 * order is 2026-04-26 → first run with candidates lands ~2031-04-26).
 *
 * Schedule: monthly, 1st of month 03:30 UTC (offset from the user
 * anonymization at 02:00 + audit-log archive at 03:00 to spread Neon I/O).
 */
export const orderAnonymizeAtFiveYears: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-anonymize-5y-monthly',
    name: 'Anonymize orders older than 5 years (Egypt MOF retention window)',
    retries: 2,
    triggers: [{ cron: '30 3 1 * *' }],
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - ORDER_ANONYMIZE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // FORCE RLS: cross-tenant cron — use withRlsBypass throughout.
    const candidates = await step.run('find-candidates', () =>
      withRlsBypass(tx =>
        tx.order.findMany({
          where: {
            createdAt: { lt: cutoff },
            // Skip rows already anonymized (idempotent re-runs).
            // The eraseAccount path writes {anonymized: true}; checking
            // for `path: ['anonymized'], equals: true` is the prisma
            // way to query inside JSONB.
            NOT: {
              shippingAddress: {
                path: ['anonymized'],
                equals: true,
              },
            },
          },
          select: { id: true },
          take: ORDER_ANONYMIZE_BATCH_CAP,
          orderBy: { createdAt: 'asc' },
        })
      )
    );

    if (candidates.length === 0) {
      logger.info({ cutoff }, 'order-anonymize-5y: nothing to anonymize');
      return { anonymized: 0 };
    }

    let anonymized = 0;
    let failed = 0;
    const anonymizedJson = { anonymized: true } as const;

    for (const { id } of candidates) {
      try {
        await step.run(`anonymize-${id}`, () =>
          withRlsBypass(tx =>
            tx.order.update({
              where: { id },
              data: {
                customerId: null,
                shippingAddress: anonymizedJson,
                billingAddress: anonymizedJson,
                customerNotes: null,
              },
            })
          )
        );
        anonymized += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          { err, orderId: id, cutoff },
          'order-anonymize-5y: row failed, will retry next run'
        );
      }
    }

    logger.info(
      { cutoff, candidates: candidates.length, anonymized, failed },
      'order-anonymize-5y: completed'
    );
    return { anonymized, failed };
  }
);
