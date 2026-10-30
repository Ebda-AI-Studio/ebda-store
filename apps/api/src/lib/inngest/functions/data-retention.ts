import { InstapayReceiptService } from '../../../services/payment-providers/instapay-receipt.service';
import type { JobDef } from '../../jobs/types';
import { prisma, withStore, acrossStores, acrossStoresFlat } from '@ebda/database';
import { acrossOpts, alarmStoreId } from '../../jobs/store-scope';
import { storeMoney, storeRepo } from '../../repo-factory';
import { AuthService, eraseNeedsCrmReview } from '../../../services/auth.service';
import logger from '../../logger';
import { inngest } from '../client';
import { auditLog } from '../../../middleware/security';
import {
  purgeSearchLogAcrossStores,
  SEARCH_LOG_RETENTION_DAYS,
} from '../../../services/search-log.service';

/**
 * Data retention crons (iceberg item #15 / applicable GCC data-protection
 * law's "no longer than business need" principle + GDPR Art. 5(1)(e)
 * storage limitation — see docs/privacy/data-map.md).
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
// limitation principle (see docs/privacy/data-map.md).
const ORDER_ANONYMIZE_RETENTION_DAYS = 365 * 5; // 1825 days

// Caps per run so a one-time historical backlog doesn't open
// thousands of Prisma transactions in a single tick.
const ABANDONED_CART_BATCH_CAP = 10_000;
const USER_ANONYMIZE_BATCH_CAP = 200;
const ORDER_ANONYMIZE_BATCH_CAP = 500;

export const abandonedCartPurge: JobDef = inngest.createFunction(
  {
    id: 'abandoned-cart-purge-weekly',
    name: 'Purge anonymous abandoned carts older than 30 days',
    retries: 1,
    triggers: [{ cron: '0 4 * * 0' }],
  },
  async ({ event, step }) => {
    const cutoff = new Date(Date.now() - ABANDONED_CART_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // FORCE RLS: data-retention is cross-tenant — no storeId available.
    // Use withRlsBypass for all DB operations in this cron.
    // Store-scoped table: counted and purged store by store, each in its own scope.
    const candidateCount = await step.run('count-candidates', async () =>
      (
        await acrossStores(
          // PORTED (Ruling CF-R4-5): the store's own rows, on Postgres or on its Durable Object
          async storeId =>
            (await storeRepo(storeId)).db.abandonedCart.count({
              where: { storeId, createdAt: { lt: cutoff }, customerId: null },
            }),
          acrossOpts(event)
        )
      ).reduce((n, r) => n + r.value, 0)
    );

    if (candidateCount === 0) {
      logger.info({ cutoff }, 'abandoned-cart-purge: nothing to purge');
      return { purged: 0 };
    }

    const deleted = await step.run('delete-batch', async () => {
      let removed = 0;
      for (const { value } of await acrossStores(async storeId => {
        const repo = await storeRepo(storeId);
        const candidates = await repo.db.abandonedCart.findMany({
          where: { storeId, createdAt: { lt: cutoff }, customerId: null },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: ABANDONED_CART_BATCH_CAP,
        });
        if (candidates.length === 0) return 0;
        const result = await repo.writer.abandonedCart.deleteMany({
          where: { id: { in: candidates.map(c => c.id) }, storeId },
        });
        return result.count;
      }, acrossOpts(event))) {
        removed += value;
      }
      return removed;
    });

    logger.info({ cutoff, candidateCount, deleted }, 'abandoned-cart-purge: completed');
    return { purged: deleted, remaining: candidateCount - deleted };
  }
);

/**
 * search-log-purge — daily. Drops `search_query_daily` rows older than 90 Cairo days
 * (search program P0, Task 5; Ruling SEARCH-4). The rows hold no identity, but storage
 * limitation still applies: the merchant's insights page reads at most 90 days. Each store
 * is purged in its own tenant transaction (`acrossStores`, strict RLS), soft-deleted stores
 * included. Daily, so the table never holds more than ~91 days per store; one small DELETE
 * per store per run.
 */
export const searchLogPurge: JobDef = inngest.createFunction(
  {
    id: 'search-log-purge-daily',
    name: `Purge storefront search log rows older than ${SEARCH_LOG_RETENTION_DAYS} days`,
    retries: 1,
    triggers: [{ cron: '30 4 * * *' }],
  },
  async ({ step }) => {
    // Every store, soft-deleted ones included; one failing store never stops the rest.
    const { purged, failedStores } = await step.run('purge', () => purgeSearchLogAcrossStores());
    logger.info(
      { purged, failedStores, retentionDays: SEARCH_LOG_RETENTION_DAYS },
      'search-log-purge: completed'
    );
    // Loud, after every other store was purged: the run fails, so the failure watch sees it.
    if (failedStores > 0) {
      throw new Error(`search-log-purge: ${failedStores} store(s) failed; see the per-store log`);
    }
    return { purged };
  }
);

/**
 * InstaPay receipt retention (M-025): screenshots deleted (approved: right away, a missed delete is retried here;
 * rejected / voided: 30 days after the decision; drafts: 30 days after upload) and the personal fields scrubbed 180 days
 * after a final decision. Daily (a missed delete is retried the next day); per store, in the store's own scope. See docs/RETENTION.md.
 */
export const instapayReceiptRetention: JobDef = inngest.createFunction(
  {
    id: 'instapay-receipt-retention-daily',
    name: 'Delete InstaPay receipt screenshots and scrub receipt personal fields on schedule',
    retries: 1,
    triggers: [{ cron: '30 4 * * *' }],
  },
  async ({ event, step }) => {
    // an alarm run names its store (a DO store sweeps its own receipts); the cron sweeps the Postgres stores
    const only = alarmStoreId(event);
    const out = await step.run('sweep', () =>
      InstapayReceiptService.sweepRetention(new Date(), only)
    );
    logger.info(
      { images: out.images, scrubbed: out.scrubbed },
      'instapay-receipt-retention: completed'
    );
    return out;
  }
);

export const softDeletedUserAnonymize: JobDef = inngest.createFunction(
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
    // Customers live in their store's scope: found store by store.
    const candidates = await step.run('find-candidates', async () =>
      (
        await acrossStoresFlat(storeId =>
          prisma.user.findMany({
            where: {
              storeId,
              role: 'customer',
              deletedAt: { not: null, lt: cutoff },
              NOT: { email: { startsWith: 'erased-' } },
            },
            select: { id: true },
            take: USER_ANONYMIZE_BATCH_CAP,
          })
        )
      ).slice(0, USER_ANONYMIZE_BATCH_CAP)
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
 * docs/privacy/data-map.md).
 *
 * The eraseAccount path already scrubs orders' shipping/billing JSON
 * to `{ anonymized: true }` and nulls customerId AT CUSTOMER-ERASE TIME.
 * But orders whose customer NEVER asked to be erased (most cases) keep
 * their PII forever without this cron.
 *
 * Candidate: order.createdAt < now - 5y AND shippingAddress NOT already
 * `{anonymized:true}` (idempotent — re-runs skip already-scrubbed rows).
 * No-op until the first orders age into the 5y window (earliest Ebda
 * order is 2026-04-26 → first run with candidates lands ~2031-04-26).
 *
 * Schedule: monthly, 1st of month 03:30 UTC (offset from the user
 * anonymization at 02:00 + audit-log archive at 03:00 to spread Neon I/O).
 */
export const orderAnonymizeAtFiveYears: JobDef = inngest.createFunction(
  {
    id: 'order-anonymize-5y-monthly',
    name: 'Anonymize orders older than 5 years (Egypt MOF retention window)',
    retries: 2,
    triggers: [{ cron: '30 3 1 * *' }],
  },
  async ({ event, step }) => {
    const cutoff = new Date(Date.now() - ORDER_ANONYMIZE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // A store on its Durable Object scrubs its own orders on its alarm, in one statement (Ruling CF-JOBS-4B): the marker
    // `{"anonymized":true}` makes a scrubbed order stop matching, so a second delivery finds nothing left.
    const only = alarmStoreId(event);
    if (only && (await storeRepo(only)).backend === 'do') {
      const out = await step.run('anonymize-do', async () => {
        const money = await storeMoney(only);
        if (!money) throw new Error(`order-anonymize-5y: no money client for DO store ${only}`);
        return money.orderAnonymize({
          cutoffMs: cutoff.getTime(),
          limit: ORDER_ANONYMIZE_BATCH_CAP,
        });
      });
      logger.info(
        { cutoff, storeId: only, ...out },
        'order-anonymize-5y: completed (durable object)'
      );
      return { anonymized: out.anonymized, failed: 0 };
    }

    // FORCE RLS: cross-tenant cron — use withRlsBypass throughout.
    const candidates = await step.run('find-candidates', async () =>
      (
        await acrossStoresFlat(
          storeId =>
            prisma.order.findMany({
              where: {
                storeId,
                createdAt: { lt: cutoff },
                NOT: {
                  shippingAddress: {
                    path: ['anonymized'],
                    equals: true,
                  },
                },
              },
              select: { id: true, storeId: true, createdAt: true },
              take: ORDER_ANONYMIZE_BATCH_CAP,
              orderBy: { createdAt: 'asc' },
            }),
          acrossOpts(event)
        )
      )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, ORDER_ANONYMIZE_BATCH_CAP)
        .map(o => ({ id: o.id, storeId: o.storeId }))
    );

    if (candidates.length === 0) {
      logger.info({ cutoff }, 'order-anonymize-5y: nothing to anonymize');
      return { anonymized: 0 };
    }

    let anonymized = 0;
    let failed = 0;
    const anonymizedJson = { anonymized: true } as const;

    for (const { id, storeId } of candidates) {
      try {
        await step.run(`anonymize-${id}`, () =>
          withStore(storeId, tx =>
            tx.order.update({
              where: { id, storeId },
              data: {
                customerId: null,
                shippingAddress: anonymizedJson,
                billingAddress: anonymizedJson,
                customerNotes: null,
                buyerKey: null,
                areaKey: null,
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
