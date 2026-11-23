/**
 * "Needs attention" aggregate for one store (GET /stores/:storeId/attention).
 *
 * STALENESS CLASS (cache rule): NEVER-stale. These are account-status / payment / billing signals, so
 * there is deliberately NO cache of any kind (no Redis, no in-memory, no edge): every request reads
 * the live rows, and a fix shows up on the next request. The admin refetches on route change, window
 * focus and after any successful write, so no badge outlives the issue. Cost: ~8 indexed reads per
 * request; the route is rate-limited by the API-wide limiter.
 *
 * Must run inside the store's tenant context (the routes mount it behind `tenantContext`).
 */
import { prisma } from '@ebda/database';
import type { AttentionResponse } from '@ebda/shared';
import { countActionItems } from '@ebda/shared';
import { storeDb } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { featureService } from './feature.service';
import { computeAttention, type GatewayFact } from './attention.rules';

function testOk(connectionTest: unknown): boolean | null {
  const ok = (connectionTest as { ok?: unknown } | null)?.ok;
  return typeof ok === 'boolean' ? ok : null;
}

function currentMonthStartUtc(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
}

export class AttentionService {
  static async get(storeId: string): Promise<AttentionResponse> {
    const db = await storeDb(storeId);
    const store = await db.store.findUnique({
      where: { id: storeId },
      select: {
        pendingDomain: true,
        domainStatus: true,
        emailDomainId: true,
        emailDomainVerifiedAt: true,
        taxEnabled: true,
      },
    });
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');

    const [
      configs,
      products,
      zones,
      areaRates,
      subscription,
      pendingClaims,
      taxProfile,
      chatLink,
      invites,
      tax,
      whatsapp,
      staffAccounts,
    ] = await Promise.all([
      db.paymentConfig.findMany({
        where: { storeId, isEnabled: true },
        select: { provider: true, settings: true, healthStatus: true, connectionTest: true },
      }),
      db.product.count({ where: { storeId, deletedAt: null } }),
      db.shippingZone.count({ where: { storeId, isActive: true } }),
      db.shippingAreaRate.count({ where: { storeId, isActive: true } }),
      prisma.storeSubscription.findUnique({
        where: { storeId },
        select: { status: true, ordersOverLimitMonth: true },
      }),
      prisma.manualPaymentClaim.count({ where: { storeId, status: 'pending' } }),
      prisma.storeTaxProfile.findUnique({ where: { storeId }, select: { status: true } }),
      prisma.storeWhatsAppLink.findUnique({ where: { storeId }, select: { linked: true } }),
      prisma.staffInvite.count({
        where: { storeId, status: 'pending', expiresAt: { gt: new Date() } },
      }),
      featureService.isFeatureEnabled(storeId, 'tax'),
      featureService.isFeatureEnabled(storeId, 'whatsapp'),
      featureService.isFeatureEnabled(storeId, 'staff_accounts'),
    ]);

    const gateways: GatewayFact[] = configs
      .filter(c => c.provider !== 'cod' && c.provider !== 'instapay')
      .map(c => ({
        provider: c.provider,
        healthStatus: c.healthStatus ?? null,
        testOk: testOk(c.connectionTest),
      }));
    const instapay = configs.find(c => c.provider === 'instapay');
    const ip = (instapay?.settings ?? {}) as { handle?: unknown; phone?: unknown };

    const items = computeAttention({
      features: { tax, whatsapp, staffAccounts },
      domain: { pendingDomain: store.pendingDomain, domainStatus: store.domainStatus },
      emailDomain: { id: store.emailDomainId, verifiedAt: store.emailDomainVerifiedAt },
      gateways,
      instapayHasDestination: instapay ? Boolean(ip.handle || ip.phone) : null,
      products,
      deliveryZones: zones,
      deliveryAreaRates: areaRates,
      subscription: subscription
        ? {
            status: subscription.status,
            overLimitThisMonth:
              !!subscription.ordersOverLimitMonth &&
              subscription.ordersOverLimitMonth >= currentMonthStartUtc(),
          }
        : null,
      pendingBillingClaims: pendingClaims,
      tax: { enabled: store.taxEnabled, profileStatus: taxProfile?.status ?? null },
      chatLinked: chatLink?.linked === true,
      pendingStaffInvites: invites,
    });

    return { items, actionCount: countActionItems(items) };
  }
}
