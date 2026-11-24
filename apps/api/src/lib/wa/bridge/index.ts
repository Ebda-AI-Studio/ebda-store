import { createBridge } from './service';
import { createDoPort, storefrontUrlFor } from './do-port';
import { suiteBuyerKeySecret } from '../config';
import logger from '../../logger';
import { buyerProofRequired } from './proof-policy';
import { createOwnerTools } from './owner-tools';
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
    requireBuyerProof: () => buyerProofRequired(process.env.WA_BRIDGE_REQUIRE_BUYER_PROOF),
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
