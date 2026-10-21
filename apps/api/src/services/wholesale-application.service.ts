/**
 * Wholesale account applications (B2B Task 5). A SIGNED-IN, email-verified shopper applies; the merchant approves (which
 * links the shopper to a wholesale group through `customers.user_id` via `linkApprovedBuyer`, NEVER `assignByIdentity`),
 * rejects, or later revokes. The applicant is always the session user (`user_id`); the typed phone on the form is stored on
 * the application only and is never an identity. Applicant PII (business name, phone, commercial reg. no.) is covered by the
 * customer export and erasure (auth.service) and cascades with the store.
 */
import { prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { withSavepoint } from '../lib/savepoint';
import { assertWholesaleEntitled, invalidateB2bPricing } from '../lib/b2b-invalidate';
import { CustomerGroupService } from './customer-group.service';
import { EmailService } from './email.service';
import logger from '../lib/logger';

export const REAPPLY_COOLDOWN_DAYS = 30;

export interface ApplyInput {
  businessName: string;
  commercialRegNo?: string | null;
  phone: string;
  notes?: string | null;
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
    const user = await prisma.user.findFirst({
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

    const member = await prisma.customer.findFirst({
      where: { storeId, userId, group: { isWholesale: true } },
      select: { id: true },
    });
    if (member)
      throw new AppError(409, 'ALREADY_APPROVED', 'This account already has wholesale access.');

    const latest = await prisma.wholesaleApplication.findFirst({
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
    if (latest?.status === 'rejected' && latest.decidedAt) {
      const until = new Date(latest.decidedAt.getTime() + REAPPLY_COOLDOWN_DAYS * 86_400_000);
      if (until.getTime() > Date.now()) {
        throw new AppError(
          429,
          'REAPPLY_COOLDOWN',
          'You can apply again 30 days after a rejection.',
          {
            retryAfter: until.toISOString(),
          }
        );
      }
    }

    try {
      const created = await withSavepoint(() =>
        prisma.wholesaleApplication.create({
          data: {
            storeId,
            userId,
            businessName: input.businessName,
            commercialRegNo: input.commercialRegNo ?? null,
            phone: input.phone,
            notes: input.notes ?? null,
          },
          select: appSelect,
        })
      );
      void notify(storeId, 'received', user, input.businessName);
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
      prisma.wholesaleApplication.findFirst({
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
      prisma.customer.findFirst({
        where: { storeId, userId, group: { isWholesale: true } },
        select: { id: true },
      }),
    ]);
    return { application, isWholesale: !!member };
  },

  async list(storeId: string, opts: { status?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const rows = await prisma.wholesaleApplication.findMany({
      where: { storeId, ...(opts.status ? { status: opts.status } : {}) },
      select: {
        ...appSelect,
        user: { select: { email: true, firstName: true, lastName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  },

  async approve(storeId: string, id: string, groupId: string, actorUserId: string) {
    const app = await prisma.wholesaleApplication.findFirst({
      where: { id, storeId },
      select: appSelect,
    });
    if (!app) throw new AppError(404, 'NOT_FOUND', 'Application not found');
    if (app.status !== 'pending')
      throw new AppError(409, 'NOT_PENDING', 'This application was already decided.');
    await assertWholesaleEntitled(storeId);
    const group = await prisma.customerGroup.findFirst({
      where: { id: groupId, storeId },
      select: { id: true, isWholesale: true, isActive: true },
    });
    if (!group) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');
    if (!group.isWholesale || !group.isActive) {
      throw new AppError(422, 'GROUP_NOT_WHOLESALE', 'Choose an active wholesale group.');
    }
    // The link is made from the application's session user id, never from the typed phone / email.
    await CustomerGroupService.linkApprovedBuyer(storeId, app.userId, groupId);
    const updated = await prisma.wholesaleApplication.update({
      where: { id, storeId },
      data: { status: 'approved', groupId, decidedBy: actorUserId, decidedAt: new Date() },
      select: appSelect,
    });
    invalidateB2bPricing(storeId);
    const user = await prisma.user.findFirst({
      where: { id: app.userId, storeId },
      select: { email: true, firstName: true, lastName: true },
    });
    if (user) void notify(storeId, 'approved', user, app.businessName);
    return updated;
  },

  async reject(storeId: string, id: string, note: string | null, actorUserId: string) {
    const app = await prisma.wholesaleApplication.findFirst({
      where: { id, storeId },
      select: appSelect,
    });
    if (!app) throw new AppError(404, 'NOT_FOUND', 'Application not found');
    if (app.status !== 'pending')
      throw new AppError(409, 'NOT_PENDING', 'This application was already decided.');
    const updated = await prisma.wholesaleApplication.update({
      where: { id, storeId },
      data: {
        status: 'rejected',
        decidedBy: actorUserId,
        decidedAt: new Date(),
        decisionNote: note,
      },
      select: appSelect,
    });
    const user = await prisma.user.findFirst({
      where: { id: app.userId, storeId },
      select: { email: true, firstName: true, lastName: true },
    });
    if (user) void notify(storeId, 'rejected', user, app.businessName, note);
    return updated;
  },

  /** Revoke an approved buyer: back to the default group (or none); open carts re-price to retail at the next read. */
  async revoke(storeId: string, id: string, note: string | null, actorUserId: string) {
    const app = await prisma.wholesaleApplication.findFirst({
      where: { id, storeId },
      select: appSelect,
    });
    if (!app) throw new AppError(404, 'NOT_FOUND', 'Application not found');
    if (app.status !== 'approved')
      throw new AppError(409, 'NOT_APPROVED', 'Only an approved application can be revoked.');
    await CustomerGroupService.unlinkBuyer(storeId, app.userId, app.groupId);
    const updated = await prisma.wholesaleApplication.update({
      where: { id, storeId },
      data: {
        status: 'revoked',
        decidedBy: actorUserId,
        decidedAt: new Date(),
        decisionNote: note,
      },
      select: appSelect,
    });
    invalidateB2bPricing(storeId);
    return updated;
  },
};
