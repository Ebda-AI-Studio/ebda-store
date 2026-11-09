/**
 * Wholesale account applications (B2B Task 5). A SIGNED-IN, email-verified shopper applies; the merchant approves (which
 * links the shopper to a wholesale group through `customers.user_id` via `linkApprovedBuyer`, NEVER `assignByIdentity`),
 * rejects, or later revokes. The applicant is always the session user (`user_id`); the typed phone on the form is stored on
 * the application only and is never an identity. Applicant PII (business name, phone, commercial reg. no.) is covered by the
 * customer export and erasure (auth.service) and cascades with the store.
 */
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { customerRow, customerRows, isLiveCustomer } from '../lib/customer-directory';
import { prisma } from '@ebda/database';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { withSavepoint } from '../lib/savepoint';
import { assertWholesaleEntitled, invalidateB2bPricing } from '../lib/b2b-invalidate';
import { CustomerGroupService } from './customer-group.service';
import { EmailService } from './email.service';
import { notifyMerchantOfApplications } from '../lib/wholesale-merchant-notify';
import logger from '../lib/logger';

export const REAPPLY_COOLDOWN_DAYS = 30;
export const NUDGE_AFTER_HOURS = 48;

export interface ApplyInput {
  businessName: string;
  commercialRegNo?: string | null;
  phone: string;
  notes?: string | null;
  /** The applicant accepted the data notice on the form (review M1). The route requires literal `true`. */
  consent: true;
}

const appSelect = {
  id: true,
  userId: true,
  businessName: true,
  commercialRegNo: true,
  phone: true,
  notes: true,
  status: true,
  groupId: true,
  decidedBy: true,
  decidedAt: true,
  decisionNote: true,
  consentAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function notify(
  storeId: string,
  kind: 'received' | 'approved' | 'rejected',
  user: { email: string; firstName: string; lastName: string },
  businessName: string,
  note?: string | null
) {
  // Best-effort: an email failure never un-approves or blocks (it is not money). The queue retries transient failures.
  try {
    await EmailService.sendWholesaleNotice(storeId, {
      to: user.email,
      kind,
      customerName: `${user.firstName} ${user.lastName}`.trim(),
      businessName,
      note,
    });
  } catch (err) {
    logger.warn({ err, storeId, kind }, '[wholesale] applicant email failed (decision stands)');
  }
}

export const WholesaleApplicationService = {
  async apply(storeId: string, userId: string, input: ApplyInput) {
    await assertWholesaleEntitled(storeId);
    const doUser = await customerRow(storeId, userId);
    const user =
      doUser !== undefined
        ? doUser && isLiveCustomer(doUser)
          ? doUser
          : null
        : await prisma.user.findFirst({
            where: { id: userId, storeId, role: 'customer', status: 'active', deletedAt: null },
            select: { id: true, email: true, firstName: true, lastName: true, emailVerified: true },
          });
    if (!user) throw new AppError(404, 'NOT_FOUND', 'Customer account not found');
    // Verified email is a precondition for APPLYING (not for binding, which is the user_id link).
    if (!user.emailVerified) {
      throw new AppError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Verify your email address before applying for a wholesale account.'
      );
    }

    const member = await (
      await storeDb(storeId)
    ).customer.findFirst({
      where: { storeId, userId, group: { isWholesale: true } },
      select: { id: true },
    });
    if (member)
      throw new AppError(409, 'ALREADY_APPROVED', 'This account already has wholesale access.');

    const latest = await (
      await storeDb(storeId)
    ).wholesaleApplication.findFirst({
      where: { storeId, userId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, decidedAt: true },
    });
    if (latest?.status === 'pending') {
      throw new AppError(
        409,
        'ALREADY_PENDING',
        'You already have a wholesale application waiting for review.'
      );
    }
    // Rejected AND revoked: a revoke followed by an immediate re-apply would otherwise be unbounded (each apply sends emails).
    if ((latest?.status === 'rejected' || latest?.status === 'revoked') && latest.decidedAt) {
      const until = new Date(latest.decidedAt.getTime() + REAPPLY_COOLDOWN_DAYS * 86_400_000);
      if (until.getTime() > Date.now()) {
        throw new AppError(
          429,
          'REAPPLY_COOLDOWN',
          'You can apply again 30 days after a decision on your last application.',
          {
            retryAfter: until.toISOString(),
          }
        );
      }
    }

    try {
      const created = await withSavepoint(async () =>
        (await storeWriter(storeId)).wholesaleApplication.create({
          data: {
            storeId,
            userId,
            businessName: input.businessName,
            commercialRegNo: input.commercialRegNo ?? null,
            phone: input.phone,
            notes: input.notes ?? null,
            consentAt: new Date(),
          },
          select: appSelect,
        })
      );
      void deferAfterTenantCommit('wholesale.notify-received', () =>
        notify(storeId, 'received', user, input.businessName)
      );
      // Fail-soft (not money): a merchant-notification failure never un-creates the application.
      void deferAfterTenantCommit('wholesale.notify-merchant', async () => {
        try {
          const pendingCount = await (
            await storeDb(storeId)
          ).wholesaleApplication.count({
            where: { storeId, status: 'pending' },
          });
          await notifyMerchantOfApplications(storeId, 'received', {
            pendingCount,
            businessName: input.businessName,
          });
        } catch (err) {
          logger.warn(
            { err, storeId },
            '[wholesale] merchant notification failed (application kept)'
          );
        }
      });
      return created;
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        throw new AppError(
          409,
          'ALREADY_PENDING',
          'You already have a wholesale application waiting for review.'
        );
      }
      throw err;
    }
  },

  /** The shopper's own latest application (their own decision note is theirs to read). */
  async status(storeId: string, userId: string) {
    const [application, member] = await Promise.all([
      (await storeDb(storeId)).wholesaleApplication.findFirst({
        where: { storeId, userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          businessName: true,
          decisionNote: true,
          createdAt: true,
          decidedAt: true,
        },
      }),
      (await storeDb(storeId)).customer.findFirst({
        where: { storeId, userId, group: { isWholesale: true } },
        select: { id: true },
      }),
    ]);
    return { application, isWholesale: !!member };
  },

  async list(storeId: string, opts: { status?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    // N-9: for a DO-served store the applicant is read from the store's DO (the Postgres relation is a stale copy).
    const onDo = (await customerRow(storeId, null)) === null;
    const rows = await (
      await storeDb(storeId)
    ).wholesaleApplication.findMany({
      where: { storeId, ...(opts.status ? { status: opts.status } : {}) },
      select: {
        ...appSelect,
        ...(onDo ? {} : { user: { select: { email: true, firstName: true, lastName: true } } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const directory = onDo
      ? new Map(
          (
            (await customerRows(
              storeId,
              page.map(r => (r as { userId: string }).userId)
            )) ?? []
          ).map(u => [u.id, { email: u.email, firstName: u.firstName, lastName: u.lastName }])
        )
      : null;
    const items = directory
      ? page.map(r => ({ ...r, user: directory.get((r as { userId: string }).userId) ?? null }))
      : page;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  },

  /** Pending count and age of the oldest pending application, for the merchant badge and the nudge (review I5). */
  async summary(storeId: string) {
    const [pendingCount, oldest] = await Promise.all([
      (await storeDb(storeId)).wholesaleApplication.count({
        where: { storeId, status: 'pending' },
      }),
      (await storeDb(storeId)).wholesaleApplication.findFirst({
        where: { storeId, status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const oldestPendingAt = oldest?.createdAt ?? null;
    const oldestPendingHours = oldestPendingAt
      ? Math.floor((Date.now() - oldestPendingAt.getTime()) / 3_600_000)
      : null;
    return {
      pendingCount,
      oldestPendingAt,
      oldestPendingHours,
      overdue: oldestPendingHours !== null && oldestPendingHours >= NUDGE_AFTER_HOURS,
    };
  },

  /**
   * Decisions are CLAIMED atomically: `UPDATE ... WHERE status = <expected>` and the loser (count 0) gets 409 (review I3).
   * Two admins, or a double click, can no longer approve and reject the same application. The buyer link is made only
   * after the claim, and the claim is released again if the link fails, so a row never says approved without a link.
   */
  async approve(storeId: string, id: string, groupId: string, actorUserId: string) {
    const app = await (
      await storeDb(storeId)
    ).wholesaleApplication.findFirst({
      where: { id, storeId },
      select: appSelect,
    });
    if (!app) throw new AppError(404, 'NOT_FOUND', 'Application not found');
    if (app.status !== 'pending')
      throw new AppError(409, 'NOT_PENDING', 'This application was already decided.');
    await assertWholesaleEntitled(storeId);
    const group = await (
      await storeDb(storeId)
    ).customerGroup.findFirst({
      where: { id: groupId, storeId },
      select: { id: true, isWholesale: true, isActive: true },
    });
    if (!group) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');
    if (!group.isWholesale || !group.isActive) {
      throw new AppError(422, 'GROUP_NOT_WHOLESALE', 'Choose an active wholesale group.');
    }
    const claim = await (
      await storeWriter(storeId)
    ).wholesaleApplication.updateMany({
      where: { id, storeId, status: 'pending' },
      data: { status: 'approved', groupId, decidedBy: actorUserId, decidedAt: new Date() },
    });
    if (claim.count === 0)
      throw new AppError(409, 'NOT_PENDING', 'This application was already decided.');
    try {
      // The link is made from the application's session user id, never from the typed phone / email.
      await CustomerGroupService.linkApprovedBuyer(storeId, app.userId, groupId);
    } catch (err) {
      await (
        await storeWriter(storeId)
      ).wholesaleApplication.updateMany({
        where: { id, storeId, status: 'approved' },
        data: { status: 'pending', groupId: null, decidedBy: null, decidedAt: null },
      });
      throw err;
    }
    const updated = await (
      await storeDb(storeId)
    ).wholesaleApplication.findFirstOrThrow({
      where: { id, storeId },
      select: appSelect,
    });
    invalidateB2bPricing(storeId);
    const doUser = await customerRow(storeId, app.userId);
    const user =
      doUser !== undefined
        ? doUser && isLiveCustomer(doUser)
          ? doUser
          : null
        : await prisma.user.findFirst({
            where: { id: app.userId, storeId },
            select: { email: true, firstName: true, lastName: true },
          });
    if (user)
      void deferAfterTenantCommit('wholesale.notify-approved', () =>
        notify(storeId, 'approved', user, app.businessName)
      );
    return updated;
  },

  async reject(storeId: string, id: string, note: string | null, actorUserId: string) {
    const app = await (
      await storeDb(storeId)
    ).wholesaleApplication.findFirst({
      where: { id, storeId },
      select: appSelect,
    });
    if (!app) throw new AppError(404, 'NOT_FOUND', 'Application not found');
    const claim = await (
      await storeWriter(storeId)
    ).wholesaleApplication.updateMany({
      where: { id, storeId, status: 'pending' },
      data: {
        status: 'rejected',
        decidedBy: actorUserId,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });
    if (claim.count === 0)
      throw new AppError(409, 'NOT_PENDING', 'This application was already decided.');
    const updated = await (
      await storeDb(storeId)
    ).wholesaleApplication.findFirstOrThrow({
      where: { id, storeId },
      select: appSelect,
    });
    const doUser = await customerRow(storeId, app.userId);
    const user =
      doUser !== undefined
        ? doUser && isLiveCustomer(doUser)
          ? doUser
          : null
        : await prisma.user.findFirst({
            where: { id: app.userId, storeId },
            select: { email: true, firstName: true, lastName: true },
          });
    if (user)
      void deferAfterTenantCommit('wholesale.notify-rejected', () =>
        notify(storeId, 'rejected', user, app.businessName, note)
      );
    return updated;
  },

  /**
   * Revoke an approved buyer: out of EVERY wholesale group (review I4), whatever group they sit in now; open carts re-price to
   * retail at the next read. `membership` says what actually happened, so the merchant is never told a revoke changed
   * something when it did not: `removed` (the buyer was in a wholesale group and was moved out) or `already_not_wholesale`
   * (a later manual move had already taken them out; the application is still closed).
   */
  async revoke(storeId: string, id: string, note: string | null, actorUserId: string) {
    const app = await (
      await storeDb(storeId)
    ).wholesaleApplication.findFirst({
      where: { id, storeId },
      select: appSelect,
    });
    if (!app) throw new AppError(404, 'NOT_FOUND', 'Application not found');
    const claim = await (
      await storeWriter(storeId)
    ).wholesaleApplication.updateMany({
      where: { id, storeId, status: 'approved' },
      data: {
        status: 'revoked',
        decidedBy: actorUserId,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });
    if (claim.count === 0)
      throw new AppError(409, 'NOT_APPROVED', 'Only an approved application can be revoked.');
    let result;
    try {
      result = await CustomerGroupService.unlinkBuyer(storeId, app.userId);
    } catch (err) {
      await (
        await storeWriter(storeId)
      ).wholesaleApplication.updateMany({
        where: { id, storeId, status: 'revoked' },
        data: {
          status: 'approved',
          decidedBy: app.decidedBy,
          decidedAt: app.decidedAt,
          decisionNote: app.decisionNote,
        },
      });
      throw err;
    }
    const updated = await (
      await storeDb(storeId)
    ).wholesaleApplication.findFirstOrThrow({
      where: { id, storeId },
      select: appSelect,
    });
    invalidateB2bPricing(storeId);
    return {
      ...updated,
      membership: result.removed ? ('removed' as const) : ('already_not_wholesale' as const),
    };
  },
};
