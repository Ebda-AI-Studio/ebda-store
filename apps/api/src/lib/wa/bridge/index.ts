import { createBridge } from './service';
import { createDoPort, storefrontUrlFor } from './do-port';
import { suiteBuyerKeySecret } from '../config';
import logger from '../../logger';
import { createOwnerTools, type OrderRowLite } from './owner-tools';
import { refundedMinorByOrder } from '../../order-refunds';
import { latestPaymentIsOnline } from '../../revenue-sql';
import { memberRole } from '../../store-members';
import { isWhatsAppLinked } from '../link';
import { featureService } from '../../../services/feature.service';
import { AnalyticsService } from '../../../services/analytics.service';
import { CouponService } from '../../../services/coupon.service';
import { storeDb } from '../../repo-factory';
import { auditLog } from '../../../middleware/security';

/** The production bridge: DO port + storefront origin. Built per call (cheap, stateless). */
export const waBridge = () =>
  createBridge({
    port: createDoPort(),
    storefrontUrl: storefrontUrlFor,
    buyerKeySecret: suiteBuyerKeySecret,
    requireBuyerProof: () => process.env.WA_BRIDGE_REQUIRE_BUYER_PROOF === '1',
    log: (msg, ctx) => logger.error({ storeId: ctx.storeId, err: ctx.err }, msg),
  });

/** The owner-assistant RPC (top products, coupon create): production ports over the same services the admin uses. Built per call. */
export const ownerTools = () =>
  createOwnerTools({
    memberRole,
    currency: async storeId => (await createDoPort().storeProfile(storeId))?.currency ?? null,
    isLinked: isWhatsAppLinked,
    featureEnabled: (storeId, feature) => featureService.isFeatureEnabled(storeId, feature),
    topProducts: async (storeId, range, limit) =>
      (await AnalyticsService.getTopProducts(storeId, limit, range)).map(p => ({
        name: p.name,
        nameAr: p.nameAr ?? null,
        quantity: p.quantity,
        revenue: p.revenue,
      })),
    ordersInWindow: async (storeId, range, cap) => {
      const db = await storeDb(storeId);
      const out: OrderRowLite[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await db.order.findMany({
          where: {
            storeId,
            deletedAt: null,
            createdAt: { gte: range.startDate, lte: range.endDate },
          },
          select: {
            id: true,
            total: true,
            status: true,
            paymentStatus: true,
            payments: { select: { id: true, provider: true, createdAt: true } },
          },
          orderBy: { id: 'asc' },
          take: 1000,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (page.length === 0) break;
        const refunded = await refundedMinorByOrder(
          db,
          storeId,
          page.map(o => o.id)
        );
        for (const o of page)
          out.push({
            total: o.total,
            status: o.status,
            paymentStatus: o.paymentStatus,
            online: latestPaymentIsOnline(o.payments ?? []),
            cod: (o.payments ?? []).some(p => p.provider === 'cod'),
            refundedMinor: refunded.get(o.id) ?? 0,
          });
        if (out.length > cap || page.length < 1000) break;
        cursor = page[page.length - 1]!.id;
      }
      return out;
    },
    findCoupon: async (storeId, code) =>
      (await (
        await storeDb(storeId)
      ).coupon.findFirst({
        where: { storeId, code: { equals: code, mode: 'insensitive' } },
        select: {
          id: true,
          code: true,
          type: true,
          value: true,
          usageLimit: true,
          startsAt: true,
          expiresAt: true,
          createdAt: true,
        },
      })) ?? null,
    createCoupon: async (storeId, data) => {
      try {
        return (await CouponService.create(storeId, data)) as never;
      } catch (e) {
        if ((e as { code?: string }).code === 'DUPLICATE_CODE')
          throw Object.assign(new Error('DUPLICATE_CODE'), { code: 'DUPLICATE_CODE' });
        throw e;
      }
    },
    audit: e =>
      auditLog({
        action: e.action,
        userId: e.userId,
        storeId: e.storeId,
        resourceType: 'coupon',
        resourceId: e.resourceId,
        details: e.details,
      }),
    now: Date.now,
  });
