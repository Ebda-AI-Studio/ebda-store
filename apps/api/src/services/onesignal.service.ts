/**
 * OneSignal admin-side push notifications.
 *
 * Scoping rule (CRITICAL): a new order in store A must reach the admins of
 * store A AND every super_admin — but never another tenant's store_admin.
 * That isolation is enforced via the OneSignal `filters` parameter combining
 * `tag:store_id = orderStoreId` OR `tag:role = super_admin`. Tags are written
 * client-side at subscription time (apps/admin) and re-asserted server-side
 * when a subscription record is created so the two sources of truth agree.
 */

import { prisma } from '@force/database';
import { config } from '../config';
import logger from '../lib/logger';

const ENDPOINT = 'https://onesignal.com/api/v1/notifications';

interface NotifyOrderInput {
  orderId: string;
  orderNumber: string;
  storeId: string;
  storeName: string;
  customerName: string;
  total: number; // fils
  currency: string;
}

function isConfigured(): boolean {
  return !!(config.onesignalAppId && config.onesignalRestApiKey);
}

function adminOrderUrl(storeId: string, orderId: string): string {
  return `${config.adminUrl}/stores/${storeId}/orders/${orderId}`;
}

function formatMoney(fils: number, currency: string): string {
  return `${(fils / 1000).toFixed(3)} ${currency}`;
}

export class OneSignalService {
  /**
   * Push a notification to the admins of the store + all super_admins.
   * Fire-and-forget: failures are logged but never propagate to the caller
   * because order creation must not roll back over a notification glitch.
   */
  static async notifyAdminsOfOrder(input: NotifyOrderInput): Promise<void> {
    if (!isConfigured()) {
      logger.debug('OneSignal not configured — skipping notification');
      return;
    }

    const url = adminOrderUrl(input.storeId, input.orderId);
    const body = {
      app_id: config.onesignalAppId,
      headings: { en: 'New order', ar: 'طلب جديد' },
      contents: {
        en: `${input.orderNumber} from ${input.customerName} — ${formatMoney(input.total, input.currency)}`,
        ar: `${input.orderNumber} من ${input.customerName} — ${formatMoney(input.total, input.currency)}`,
      },
      // store_id-scoped admins OR super_admin role.
      // OneSignal `filters` are evaluated left-to-right with explicit OR/AND
      // operator entries. The shape below means:
      //   (tag:store_id = X) OR (tag:role = super_admin)
      filters: [
        { field: 'tag', key: 'store_id', relation: '=', value: input.storeId },
        { operator: 'OR' },
        { field: 'tag', key: 'role', relation: '=', value: 'super_admin' },
      ],
      url,
      web_buttons: [{ id: 'view-order', text: 'View order', url }],
      data: {
        type: 'order.created',
        orderId: input.orderId,
        storeId: input.storeId,
        storeName: input.storeName,
      },
    };

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // OneSignal v2 accepts both `Basic <REST_API_KEY>` (legacy) and
          // `Key <REST_API_KEY>` (current). Using `Key` matches Beethoven's
          // existing helper so credentials shipped from there work as-is.
          Authorization: `Key ${config.onesignalRestApiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        logger.error({ status: res.status, body: errBody }, 'OneSignal push failed');
      }
    } catch (err) {
      logger.error({ err }, 'OneSignal push threw');
    }
  }

  /**
   * Persist a player_id <-> user_id mapping so we have a server record of
   * which devices belong to which admin. This lets a future "Logout from
   * everywhere" feature revoke pushes without waiting for OneSignal tags
   * to update.
   */
  static async upsertSubscription(
    userId: string,
    playerId: string,
    deviceLabel?: string
  ): Promise<void> {
    await prisma.oneSignalSubscription.upsert({
      where: { userId_playerId: { userId, playerId } },
      create: { userId, playerId, deviceLabel },
      update: { deviceLabel },
    });
  }

  static async listSubscriptions(userId: string) {
    return prisma.oneSignalSubscription.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  static async deleteSubscription(userId: string, playerId: string): Promise<void> {
    await prisma.oneSignalSubscription
      .delete({ where: { userId_playerId: { userId, playerId } } })
      .catch(err => {
        // not-found is fine — the user may have already removed it elsewhere
        if (err?.code !== 'P2025') throw err;
      });
  }
}
