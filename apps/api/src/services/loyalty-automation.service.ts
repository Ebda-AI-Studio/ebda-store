/**
 * Loyalty Automation Service
 *
 * Runs daily cron jobs for automated loyalty program actions:
 *   1. Birthday bonus  — award birthdayBonus points to customers whose birthday is today
 *   2. Point expiration — deduct expired points and create 'expire' transactions
 *
 * Processing lifecycle:
 *   startCron() → setInterval (daily) → runDailyAutomation()
 *     ├─ processBirthdayBonuses()
 *     └─ processPointExpiration()
 */

import { prisma, runInStoreScope, storeDirectory } from '@ebda/database';
import { featureService } from './feature.service';
import { storeMoney } from '../lib/repo-factory';
import { withLeaderLock } from '../lib/leader-election';
import logger from '../lib/logger';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BIRTHDAY_BONUS = 500;
const DEFAULT_EXPIRATION_MONTHS = 12;
const SCAN_BATCH_SIZE = 500;

// ─── Service ──────────────────────────────────────────────────────────────────

class LoyaltyAutomationService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  // ──────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────

  startCron(intervalMs = 24 * 60 * 60 * 1000): void {
    if (this.intervalHandle) {
      logger.warn('[LoyaltyAutomation] Already running — ignoring startCron() call');
      return;
    }

    logger.info({ intervalMs }, '[LoyaltyAutomation] Starting daily cron');

    // Run once at startup (leader-gated) then on each interval.
    // The withLeaderLock guard ensures only one replica runs the job per tick
    // even when Railway scales to multiple instances.
    withLeaderLock('loyalty-automation-daily', intervalMs, () => this.runDailyAutomation()).catch(
      err => {
        logger.error({ err }, '[LoyaltyAutomation] Error on initial run');
      }
    );

    this.intervalHandle = setInterval(() => {
      withLeaderLock('loyalty-automation-daily', intervalMs, () => this.runDailyAutomation()).catch(
        err => {
          logger.error({ err }, '[LoyaltyAutomation] Unhandled error in runDailyAutomation()');
        }
      );
    }, intervalMs);
  }

  stopCron(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info('[LoyaltyAutomation] Cron stopped');
    }
  }

  // ──────────────────────────────────────────
  // Main Daily Runner
  // ──────────────────────────────────────────

  async runDailyAutomation(): Promise<void> {
    logger.info('[LoyaltyAutomation] Running daily automation');

    await Promise.allSettled([this.processBirthdayBonuses(), this.processPointExpiration()]);

    logger.info('[LoyaltyAutomation] Daily automation complete');
  }

  // ──────────────────────────────────────────
  // 1. Birthday Bonus
  // ──────────────────────────────────────────

  async processBirthdayBonuses(): Promise<void> {
    const now = new Date();
    const todayMonth = now.getMonth() + 1; // 1-12
    const todayDay = now.getDate(); // 1-31
    const thisYear = now.getFullYear();

    logger.info(
      { month: todayMonth, day: todayDay },
      '[LoyaltyAutomation] Processing birthday bonuses'
    );

    try {
      // Find all stores with loyalty enabled (`stores` is under RLS: the cron lists
      // them through the directory definer and reads each one's settings in its scope).
      const stores = await storeDirectory(s => s.loyaltyEnabled);

      for (const store of stores) {
        await runInStoreScope(store.id, async () => {
          // Check feature flag
          const loyaltyEnabled = await featureService.isFeatureEnabled(store.id, 'loyalty');
          if (!loyaltyEnabled) return;

          // Ruling NZ-PG-7: a store on its Durable Object awards in its DO (one section); no Postgres read or write.
          const money = await storeMoney(store.id);
          if (money) {
            const r = await money.loyaltyBirthdays({
              month: todayMonth,
              day: todayDay,
              yearStart: new Date(thisYear, 0, 1).getTime(),
              featureEnabled: true,
            });
            if (r.awarded > 0)
              logger.info(
                { storeId: store.id, awarded: r.awarded, points: r.points },
                '[LoyaltyAutomation] Birthday bonuses awarded (DO)'
              );
            return;
          }

          const row = await prisma.store.findUnique({
            where: { id: store.id },
            select: { loyaltySettings: true },
          });
          const settings = (row?.loyaltySettings ?? null) as Record<string, unknown> | null;
          const birthdayBonus =
            typeof settings?.birthdayBonus === 'number'
              ? settings.birthdayBonus
              : DEFAULT_BIRTHDAY_BONUS;
          const expirationMonths =
            typeof settings?.expirationMonths === 'number'
              ? settings.expirationMonths
              : DEFAULT_EXPIRATION_MONTHS;

          if (birthdayBonus <= 0) return;

          // Find loyalty members in this store whose birthday is today.
          // Cursor-batch through the table in pages of SCAN_BATCH_SIZE to
          // avoid a single multi-MB memory spike on stores with 10k+ members.
          // Birthday-today filtering happens per page in JS; Postgres-side
          // EXTRACT predicate would be cleaner but isn't reachable from
          // Prisma's typed API without raw SQL — cursor batching is the
          // policy-compliant middle ground (see scaling-cliff rule).
          type LoyaltyMember = {
            id: string;
            customerId: string;
            points: number;
            totalEarned: number;
            tier: string;
            customer: {
              id: string;
              firstName: string | null;
              lastName: string | null;
              dateOfBirth: Date | null;
            };
          };
          const birthdayMembers: LoyaltyMember[] = [];
          let cursor: string | undefined;
          while (true) {
            const batch: LoyaltyMember[] = await prisma.loyaltyPoints.findMany({
              where: { storeId: store.id },
              select: {
                id: true,
                customerId: true,
                points: true,
                totalEarned: true,
                tier: true,
                customer: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    dateOfBirth: true,
                  },
                },
              },
              take: SCAN_BATCH_SIZE,
              orderBy: { id: 'asc' },
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });

            if (batch.length === 0) break;

            for (const m of batch) {
              const dob = m.customer.dateOfBirth;
              if (!dob) continue;
              if (dob.getMonth() + 1 === todayMonth && dob.getDate() === todayDay) {
                birthdayMembers.push(m);
              }
            }

            if (batch.length < SCAN_BATCH_SIZE) break;
            cursor = batch[batch.length - 1].id;
          }

          // Bulk lookup of customers who already received this year's
          // birthday bonus. Previously the per-member findFirst loop ran
          // N queries; on a store with hundreds of birthday-aligned
          // customers that turned a daily cron into a slow-then-timeout
          // pathology. One IN-list query is fine even at large N because
          // we already capped the candidate set above.
          const yearStart = new Date(thisYear, 0, 1);
          const candidateIds = birthdayMembers.map(m => m.customerId);
          const alreadyAwarded =
            candidateIds.length === 0
              ? new Set<string>()
              : new Set(
                  (
                    await prisma.loyaltyTransaction.findMany({
                      where: {
                        storeId: store.id,
                        customerId: { in: candidateIds },
                        type: 'earn_birthday',
                        createdAt: { gte: yearStart },
                      },
                      select: { customerId: true },
                    })
                  ).map(t => t.customerId)
                );

          for (const member of birthdayMembers) {
            try {
              if (alreadyAwarded.has(member.customerId)) {
                logger.debug(
                  { storeId: store.id, customerId: member.customerId },
                  '[LoyaltyAutomation] Birthday bonus already awarded this year — skipping'
                );
                continue;
              }

              // Award birthday bonus
              const expiresAt =
                expirationMonths > 0
                  ? new Date(Date.now() + expirationMonths * 30 * 24 * 60 * 60 * 1000)
                  : null;

              await prisma.$transaction([
                prisma.loyaltyPoints.update({
                  where: { id: member.id, storeId: store.id },
                  data: {
                    points: { increment: birthdayBonus },
                    totalEarned: { increment: birthdayBonus },
                  },
                }),
                prisma.loyaltyTransaction.create({
                  data: {
                    storeId: store.id,
                    customerId: member.customerId,
                    type: 'earn_birthday',
                    points: birthdayBonus,
                    description: `Happy Birthday! ${birthdayBonus} bonus points`,
                    expiresAt,
                  },
                }),
              ]);

              logger.info(
                {
                  storeId: store.id,
                  customerId: member.customerId,
                  points: birthdayBonus,
                },
                '[LoyaltyAutomation] Birthday bonus awarded'
              );
            } catch (err) {
              logger.error(
                { err, storeId: store.id, customerId: member.customerId },
                '[LoyaltyAutomation] Failed to award birthday bonus'
              );
            }
          }
        });
      }
    } catch (err) {
      logger.error({ err }, '[LoyaltyAutomation] processBirthdayBonuses failed');
    }
  }

  // ──────────────────────────────────────────
  // 2. Point Expiration
  // ──────────────────────────────────────────

  async processPointExpiration(): Promise<void> {
    // `stores` is under RLS: the cron lists stores through the directory definer.
    const stores = await storeDirectory();
    for (const store of stores) {
      // one store failing (a DO that cannot be read) never stops the sweep over the others
      try {
        await runInStoreScope(store.id, async () => {
          // Ruling NZ-PG-7: a store on its Durable Object expires points in its DO, a page at a time; no Postgres.
          const money = await storeMoney(store.id);
          if (!money) return this.processStorePointExpiration(store.id);
          let after: string | null = null;
          for (let page = 0; page < 200; page++) {
            const r: { members: number; expired: number; last: string | null; more: boolean } =
              await money.loyaltyExpire({ after });
            if (r.members > 0)
              logger.info(
                { storeId: store.id, members: r.members, expired: r.expired },
                '[LoyaltyAutomation] Points expired (DO)'
              );
            if (!r.more || !r.last) break;
            after = r.last;
          }
        });
      } catch (err) {
        logger.error({ err, storeId: store.id }, '[LoyaltyAutomation] point expiration failed');
      }
    }
  }

  private async processStorePointExpiration(storeId: string): Promise<void> {
    const now = new Date();

    logger.info('[LoyaltyAutomation] Processing point expiration');

    try {
      // Find all positive (earn) transactions that have expired and haven't been
      // processed yet. We detect "already processed" by checking that no
      // 'expire' transaction with a matching description exists.
      //
      // To keep this simple and safe, we group by storeId+customerId:
      // aggregate total expired points per member then create a single deduction.

      // Get all expired positive transactions (earn types) not yet expired.
      // Cursor-batch in pages of SCAN_BATCH_SIZE so an annual sweep across
      // every store doesn't load the whole table into one container.
      type ExpiredTxn = {
        id: string;
        storeId: string;
        customerId: string;
        points: number;
        expiresAt: Date | null;
      };
      const expiredTxns: ExpiredTxn[] = [];
      let txnCursor: string | undefined;
      while (true) {
        const batch: ExpiredTxn[] = await prisma.loyaltyTransaction.findMany({
          where: {
            storeId,
            expiresAt: { lt: now },
            points: { gt: 0 },
            type: {
              in: [
                'earn_purchase',
                'earn_signup',
                'earn_referral',
                'earn_review',
                'earn_birthday',
                'earn_manual',
              ],
            },
          },
          select: {
            id: true,
            storeId: true,
            customerId: true,
            points: true,
            expiresAt: true,
          },
          take: SCAN_BATCH_SIZE,
          orderBy: { id: 'asc' },
          ...(txnCursor ? { cursor: { id: txnCursor }, skip: 1 } : {}),
        });

        if (batch.length === 0) break;
        expiredTxns.push(...batch);
        if (batch.length < SCAN_BATCH_SIZE) break;
        txnCursor = batch[batch.length - 1].id;
      }

      if (expiredTxns.length === 0) {
        logger.debug('[LoyaltyAutomation] No expired transactions found');
        return;
      }

      // Group by storeId+customerId
      const grouped = new Map<
        string,
        { storeId: string; customerId: string; totalExpired: number; txnIds: string[] }
      >();

      for (const txn of expiredTxns) {
        const key = `${txn.storeId}:${txn.customerId}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.totalExpired += txn.points;
          existing.txnIds.push(txn.id);
        } else {
          grouped.set(key, {
            storeId: txn.storeId,
            customerId: txn.customerId,
            totalExpired: txn.points,
            txnIds: [txn.id],
          });
        }
      }

      // Batch the loyaltyPoints lookup. The previous per-group findUnique
      // ran one query per (store, customer) pair; on annual expiration
      // sweeps that's the dominant cost. Single findMany with composite
      // filters keeps the cron under the connection-pool budget.
      const groupKeys = [...grouped.values()];
      const records =
        groupKeys.length === 0
          ? []
          : await prisma.loyaltyPoints.findMany({
              // Every group belongs to `storeId` (the scan above is store-scoped).
              where: {
                storeId,
                customerId: { in: groupKeys.map(g => g.customerId) },
              },
              select: { id: true, storeId: true, customerId: true, points: true },
            });
      const recordByKey = new Map<
        string,
        { id: string; storeId: string; customerId: string; points: number }
      >();
      for (const r of records) {
        recordByKey.set(`${r.storeId}:${r.customerId}`, r);
      }

      for (const [, group] of grouped) {
        try {
          const loyaltyRecord = recordByKey.get(`${group.storeId}:${group.customerId}`);

          if (!loyaltyRecord) continue;

          // Deduct from balance (never go below 0)
          const deduction = Math.min(group.totalExpired, loyaltyRecord.points);
          if (deduction <= 0) {
            // Still null-out the expiresAt so we don't re-process
            await prisma.loyaltyTransaction.updateMany({
              where: { id: { in: group.txnIds }, storeId },
              data: { expiresAt: null },
            });
            continue;
          }

          await prisma.$transaction([
            prisma.loyaltyPoints.update({
              where: { id: loyaltyRecord.id, storeId },
              data: {
                points: { decrement: deduction },
                totalRedeemed: { increment: deduction },
              },
            }),
            prisma.loyaltyTransaction.create({
              data: {
                storeId: group.storeId,
                customerId: group.customerId,
                type: 'expire',
                points: -deduction,
                description: `${deduction} points expired`,
              },
            }),
            // Null out expiresAt to mark as processed (idempotency)
            prisma.loyaltyTransaction.updateMany({
              where: { id: { in: group.txnIds }, storeId },
              data: { expiresAt: null },
            }),
          ]);

          logger.info(
            {
              storeId: group.storeId,
              customerId: group.customerId,
              deduction,
              txnsProcessed: group.txnIds.length,
            },
            '[LoyaltyAutomation] Points expired'
          );
        } catch (err) {
          logger.error(
            { err, storeId: group.storeId, customerId: group.customerId },
            '[LoyaltyAutomation] Failed to process expiration for member'
          );
        }
      }
    } catch (err) {
      logger.error({ err }, '[LoyaltyAutomation] processPointExpiration failed');
    }
  }
}

export const loyaltyAutomationService = new LoyaltyAutomationService();
