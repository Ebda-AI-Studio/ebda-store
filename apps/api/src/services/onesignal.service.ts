/**
 * OneSignal admin-side push notifications.
 *
 * Scoping rule (CRITICAL): a new order in store A must reach the admins of
 * store A AND every super_admin — but never another tenant's store_admin.
 * That isolation is enforced via the OneSignal `filters` parameter combining
 * `tag:store_id = orderStoreId` OR `tag:role = super_admin`. Tags are written
 * client-side at subscription time (apps/admin) and re-asserted server-side
 * when a subscription record is created so the two sources of truth agree.
 *
 * Storefront broadcast scoping uses the SAME tag mechanism but a different
 * key: storefront devices are tagged with `storeId` (the customer's store)
 * at consent time so `broadcastToStore` can target only that tenant.
 */

import { withStore, withUser } from '@ebda/database';
import { adminPushPlayerIds } from '../lib/definer';
import { config } from '../config';
import logger from '../lib/logger';

import { minorToDecimalString } from '@ebda/shared';
import { timedFetch } from '../lib/fetch-with-timeout';
const ENDPOINT = 'https://onesignal.com/api/v1/notifications';

interface NotifyOrderInput {
  orderId: string;
  orderNumber: string;
  storeId: string;
  storeName: string;
  customerName: string;
  total: number; // piastres
  currency: string;
  /** Payment method the customer chose at checkout (e.g. 'cod', 'paymob',
   *  'visa'). Surfaced in the super_admin push body so platform staff can
   *  triage at a glance — COD orders need active warehouse handling
   *  whereas card-paid orders can wait. */
  paymentMethod?: string;
}

/** Human-readable payment method for the push body. Falls back to a
 *  title-cased version of the raw value so unknown providers still
 *  render readably without us having to hardcode every one. */
function formatPaymentMethod(method: string | undefined): string {
  if (!method) return '—';
  const normalized = method.toLowerCase().trim();
  const labels: Record<string, string> = {
    cod: 'Cash on Delivery',
    cash: 'Cash on Delivery',
    cash_on_delivery: 'Cash on Delivery',
    instapay: 'InstaPay',
    paymob: 'Paymob',
    kashier: 'Kashier',
    fawry: 'Fawry',
    geidea: 'Geidea',
    visa: 'Visa',
    mastercard: 'Mastercard',
    meeza: 'Meeza',
    wallet: 'Mobile wallet',
    valu: 'valU',
    apple_pay: 'Apple Pay',
  };
  if (labels[normalized]) return labels[normalized];
  // Title-case fallback for unknown methods.
  return normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Input for an Orders-PWA new-order push. Mirrors NotifyOrderInput but the
 *  Orders app doesn't need storeName/paymentMethod (it targets a single store
 *  by tag and the staff already know which store they're in). */
interface NotifyOrdersAppInput {
  orderId: string;
  orderNumber: string;
  storeId: string;
  total: number; // piastres
  currency: string;
  customerName: string;
  /** Buyer locale — only used to pick which contents string leads (both
   *  en + ar are always sent so OneSignal renders the device's language). */
  locale?: 'en' | 'ar';
}

export interface BroadcastInput {
  storeId: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  url?: string;
}

export interface BroadcastResult {
  id: string;
  recipients: number;
}

export interface BroadcastSummary {
  id: string;
  headings?: { en?: string; ar?: string };
  contents?: { en?: string; ar?: string };
  url?: string;
  successful?: number;
  converted?: number;
  failed?: number;
  remaining?: number;
  queued_at?: number;
  send_after?: number;
  completed_at?: number;
}

export class OneSignalNotConfiguredError extends Error {
  code = 'PUSH_NOT_CONFIGURED' as const;
  constructor() {
    super('OneSignal credentials are not configured on the server.');
    this.name = 'OneSignalNotConfiguredError';
  }
}

export class OneSignalRequestError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`OneSignal request failed with status ${status}`);
    this.name = 'OneSignalRequestError';
    this.status = status;
    this.body = body;
  }
}

/** Storefront app — used by `broadcastToStore` (customer-facing pushes
 *  from merchants). Origin: https://ebda.app. */
function isStorefrontConfigured(): boolean {
  return !!(config.onesignalAppId && config.onesignalRestApiKey);
}

/** Admin app — used by `notifyAdminsOfOrder` (new-order pings to store
 *  owners). Origin: https://store.ebda.app. Distinct from the
 *  storefront app because OneSignal locks each app to a single origin. */
function isAdminConfigured(): boolean {
  return !!(config.onesignalAdminAppId && config.onesignalAdminRestApiKey);
}

/** Orders PWA — used by `notifyOrdersAppOfOrder` (new-order pings to store
 *  staff running the Orders app). Origin: https://orders.ebda.app.
 *  A SEPARATE OneSignal app from both the admin and storefront ones because
 *  OneSignal locks each app to a single origin. No fallback — when unset we
 *  skip the send silently (see `notifyOrdersAppOfOrder`). */
function isOrdersConfigured(): boolean {
  return !!(config.onesignalOrdersAppId && config.onesignalOrdersRestApiKey);
}

// Backwards-compat alias for code paths not yet split into admin vs storefront.
function isConfigured(): boolean {
  return isStorefrontConfigured();
}

function adminOrderUrl(storeId: string, orderId: string): string {
  return `${config.adminUrl}/stores/${storeId}/orders/${orderId}`;
}

/** Deep-link to the order on the Orders PWA. The Orders app route is
 *  `/orders/[orderId]` and reads the active store from `?store=`. OneSignal
 *  opens this `url` natively on notification click → straight to the order. */
function ordersAppOrderUrl(orderId: string, storeId: string): string {
  return `${config.ordersUrl}/orders/${orderId}?store=${encodeURIComponent(storeId)}`;
}

function formatMoney(piastres: number, currency: string): string {
  return `${minorToDecimalString(piastres, currency)} ${currency}`;
}

export class OneSignalService {
  /**
   * Push a notification to the admins of the store + all super_admins.
   * Fire-and-forget: failures are logged but never propagate to the caller
   * because order creation must not roll back over a notification glitch.
   */
  static async notifyAdminsOfOrder(input: NotifyOrderInput): Promise<void> {
    // Admin pushes go through the admin OneSignal app (origin
    // store.ebda.app), NOT the storefront app. OneSignal locks each
    // app to a single chrome_web_origin so we can't reuse the storefront
    // app for admin devices — they'd fail subscription with an origin
    // mismatch error.
    if (!isAdminConfigured()) {
      logger.warn(
        {
          hasAppId: !!config.onesignalAdminAppId,
          hasRestKey: !!config.onesignalAdminRestApiKey,
        },
        'Admin OneSignal not configured — skipping order notification (set ONESIGNAL_ADMIN_APP_ID and ONESIGNAL_ADMIN_REST_API_KEY)'
      );
      return;
    }

    const url = adminOrderUrl(input.storeId, input.orderId);
    const dataPayload = {
      type: 'order.created',
      orderId: input.orderId,
      storeId: input.storeId,
      storeName: input.storeName,
    };
    const sharedFields = {
      app_id: config.onesignalAdminAppId,
      url,
      web_buttons: [{ id: 'view-order', text: 'View order', url }],
      data: dataPayload,
    };

    const moneyText = formatMoney(input.total, input.currency);
    const paymentLabel = formatPaymentMethod(input.paymentMethod);

    // Targeting strategy: prefer `include_player_ids` over tag filters.
    //
    // Tag-filter delivery is fragile — tags are written client-side AFTER
    // OneSignal.init resolves, so a slow connection / race / opted-out
    // browser can leave a device subscribed but un-tagged. Then
    // `recipients: 0` with no clear cause. Beethoven (the bathroom queue
    // app, same OneSignal v16 SDK) skips tags entirely and tracks
    // `playerId` server-side at subscribe-time — that's been rock-solid.
    //
    // We do the same here: look up admins (store_admins of this store +
    // every super_admin) by role, join with `OneSignalSubscription` to
    // resolve to player_ids, send to those player_ids directly. The
    // tag-based filter still ships as a fallback for devices that
    // subscribed via OneSignal but never POSTed their player_id to
    // `/admin/notifications/onesignal/subscribe` (e.g. the registration
    // call failed once and the subscription record was never written).

    const [storeAdminPlayerIds, superAdminPlayerIds] = await Promise.all([
      this.getAdminPlayerIds({ role: 'store_admin', ownsStoreId: input.storeId }),
      this.getAdminPlayerIds({ role: 'super_admin', ownsStoreId: input.storeId }),
    ]);

    const storeAdminBody = {
      ...sharedFields,
      headings: { en: 'New order', ar: 'طلب جديد' },
      contents: {
        en: `${input.orderNumber} from ${input.customerName} — ${moneyText}`,
        ar: `${input.orderNumber} من ${input.customerName} — ${moneyText}`,
      },
      // Prefer DB-backed targeting; fall back to tag filter when no
      // subscription rows exist (e.g. older devices). One Promise per
      // strategy — never both at once or OneSignal double-sends.
      ...(storeAdminPlayerIds.length > 0
        ? { include_player_ids: storeAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }] }),
    };

    const superAdminBody = {
      ...sharedFields,
      headings: { en: 'New order', ar: 'طلب جديد' },
      contents: {
        en: `${input.storeName} — ${moneyText} · ${paymentLabel}`,
        ar: `${input.storeName} — ${moneyText} · ${paymentLabel}`,
      },
      ...(superAdminPlayerIds.length > 0
        ? { include_player_ids: superAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'role', relation: '=', value: 'super_admin' }] }),
    };

    const send = async (body: unknown, audience: 'store_admin' | 'super_admin') => {
      try {
        const res = await timedFetch('onesignal.send')(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Admin REST key — pairs with onesignalAdminAppId in the
            // request body. OneSignal v2 accepts both `Basic` (legacy)
            // and `Key` (current); we use `Key`.
            Authorization: `Key ${config.onesignalAdminRestApiKey}`,
          },
          body: JSON.stringify(body),
        });
        const responseText = await res.text().catch(() => '');
        if (!res.ok) {
          logger.error(
            { status: res.status, body: responseText, audience },
            'OneSignal push failed'
          );
          return;
        }
        // 2xx ≠ delivered. OneSignal returns 200 with `recipients: 0`
        // when the filter matches no devices — the most common silent
        // failure when admin tags weren't set on the user's PWA. Log
        // the recipient count + any returned `errors` so the merchant
        // (or we) can see at a glance why a push didn't show up.
        let parsed: { id?: string; recipients?: number; errors?: unknown } = {};
        try {
          parsed = JSON.parse(responseText);
        } catch {
          // unparseable body is fine — fall through to the generic log
        }
        const recipients = typeof parsed.recipients === 'number' ? parsed.recipients : -1;
        const meta = {
          audience,
          notificationId: parsed.id,
          recipients,
          errors: parsed.errors,
        };
        if (recipients === 0) {
          logger.warn(
            meta,
            'OneSignal push delivered to 0 devices — check that admin tags (role, store_id) are set on subscribed devices'
          );
        } else {
          logger.info(meta, 'OneSignal admin push sent');
        }
      } catch (err) {
        logger.error({ err, audience }, 'OneSignal push threw');
      }
    };

    // Fire both in parallel — a slow OneSignal response shouldn't block
    // the other audience's push.
    await Promise.all([send(storeAdminBody, 'store_admin'), send(superAdminBody, 'super_admin')]);
  }

  /**
   * Push a "New order" notification to the staff running the Orders PWA
   * (orders.ebda.app) for THIS store. Distinct from
   * `notifyAdminsOfOrder` (admin PWA, store.ebda.app) — a different
   * device set + a different OneSignal app, so the two never double-send.
   *
   * Targeting is TAG-BASED: the Orders app tags each subscribed device with
   * `store_id = <selectedStoreId>` at enable time, and we filter on that tag
   * here. No DB player-id storage and no server-side subscribe POST — that
   * avoids the 403 server-subscribe path the old VAPID flow tripped on.
   *
   * Fire-and-forget: failures are logged but never propagate to the caller
   * because order creation must not roll back over a notification glitch.
   * Skips silently when the Orders OneSignal app isn't configured.
   */
  static async notifyOrdersAppOfOrder(input: NotifyOrdersAppInput): Promise<void> {
    if (!isOrdersConfigured()) {
      logger.warn(
        {
          hasAppId: !!config.onesignalOrdersAppId,
          hasRestKey: !!config.onesignalOrdersRestApiKey,
        },
        'Orders OneSignal not configured — skipping orders-app notification (set ONESIGNAL_ORDERS_APP_ID and ONESIGNAL_ORDERS_REST_API_KEY)'
      );
      return;
    }

    const url = ordersAppOrderUrl(input.orderId, input.storeId);
    const moneyText = formatMoney(input.total, input.currency);

    const body = {
      app_id: config.onesignalOrdersAppId,
      url,
      web_buttons: [{ id: 'view-order', text: 'View order', url }],
      data: {
        type: 'order.created',
        orderId: input.orderId,
        storeId: input.storeId,
      },
      headings: { en: 'New order', ar: 'طلب جديد' },
      contents: {
        en: `${input.orderNumber} — ${input.customerName} — ${moneyText}`,
        ar: `${input.orderNumber} — ${input.customerName} — ${moneyText}`,
      },
      // Tag-based targeting — the Orders app sets `store_id` on enable. Only
      // devices tagged with THIS store's id receive the push, so one store's
      // staff never sees another tenant's orders.
      filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }],
    };

    try {
      const res = await timedFetch('onesignal.send')(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${config.onesignalOrdersRestApiKey}`,
        },
        body: JSON.stringify(body),
      });
      const responseText = await res.text().catch(() => '');
      if (!res.ok) {
        logger.error(
          { status: res.status, body: responseText, storeId: input.storeId },
          'OneSignal orders-app push failed'
        );
        return;
      }
      // 2xx ≠ delivered. OneSignal returns 200 with `recipients: 0` when the
      // tag filter matches no devices — log the count so a missing push has a
      // clear cause (no staff enabled / store_id tag not set).
      let parsed: { id?: string; recipients?: number; errors?: unknown } = {};
      try {
        parsed = JSON.parse(responseText);
      } catch {
        // unparseable body — fall through to the generic log
      }
      const recipients = typeof parsed.recipients === 'number' ? parsed.recipients : -1;
      const meta = {
        storeId: input.storeId,
        notificationId: parsed.id,
        recipients,
        errors: parsed.errors,
      };
      if (recipients === 0) {
        logger.warn(
          meta,
          'OneSignal orders-app push delivered to 0 devices — check that staff enabled notifications and the store_id tag is set'
        );
      } else {
        logger.info(meta, 'OneSignal orders-app push sent');
      }
    } catch (err) {
      logger.error({ err, storeId: input.storeId }, 'OneSignal orders-app push threw');
    }
  }

  /**
   * Push a "Payment received" notification to admins of the store +
   * super_admins. Fired from `confirmPaymentFromProviderStatus` on a real
   * pending→paid transition (statusChanged === true) — so when a customer
   * pays a resent / previously-stuck payment link, the merchant gets a
   * distinct "Payment received" ping (answering "did the resend work?").
   * Distinct from the "New order" push (which fires on order creation) — this
   * confirms the MONEY landed, not just that an order exists.
   *
   * Fire-and-forget: failures are logged but never propagate to the caller
   * because payment reconciliation must not roll back over a push glitch.
   */
  static async notifyAdminsOfPaymentSuccess(input: NotifyOrderInput): Promise<void> {
    if (!isAdminConfigured()) {
      logger.warn(
        {
          hasAppId: !!config.onesignalAdminAppId,
          hasRestKey: !!config.onesignalAdminRestApiKey,
        },
        'Admin OneSignal not configured — skipping payment-received notification'
      );
      return;
    }

    const url = adminOrderUrl(input.storeId, input.orderId);
    const dataPayload = {
      type: 'order.payment_received',
      orderId: input.orderId,
      storeId: input.storeId,
      storeName: input.storeName,
    };
    const sharedFields = {
      app_id: config.onesignalAdminAppId,
      url,
      web_buttons: [{ id: 'view-order', text: 'View order', url }],
      data: dataPayload,
    };

    const moneyText = formatMoney(input.total, input.currency);
    const paymentLabel = formatPaymentMethod(input.paymentMethod);

    const [storeAdminPlayerIds, superAdminPlayerIds] = await Promise.all([
      this.getAdminPlayerIds({ role: 'store_admin', ownsStoreId: input.storeId }),
      this.getAdminPlayerIds({ role: 'super_admin', ownsStoreId: input.storeId }),
    ]);

    const storeAdminBody = {
      ...sharedFields,
      headings: { en: 'Payment received', ar: 'تم استلام الدفع' },
      contents: {
        en: `Order ${input.orderNumber} — ${moneyText} paid`,
        ar: `الطلب ${input.orderNumber} — تم دفع ${moneyText}`,
      },
      ...(storeAdminPlayerIds.length > 0
        ? { include_player_ids: storeAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }] }),
    };

    const superAdminBody = {
      ...sharedFields,
      headings: { en: 'Payment received', ar: 'تم استلام الدفع' },
      contents: {
        en: `${input.storeName} — Order ${input.orderNumber} — ${moneyText} paid · ${paymentLabel}`,
        ar: `${input.storeName} — الطلب ${input.orderNumber} — تم دفع ${moneyText} · ${paymentLabel}`,
      },
      ...(superAdminPlayerIds.length > 0
        ? { include_player_ids: superAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'role', relation: '=', value: 'super_admin' }] }),
    };

    const send = async (body: unknown, audience: 'store_admin' | 'super_admin') => {
      try {
        const res = await timedFetch('onesignal.send')(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Key ${config.onesignalAdminRestApiKey}`,
          },
          body: JSON.stringify(body),
        });
        const responseText = await res.text().catch(() => '');
        if (!res.ok) {
          logger.error(
            { status: res.status, body: responseText, audience },
            'OneSignal payment-received push failed'
          );
          return;
        }
        logger.info({ audience }, 'OneSignal payment-received push sent');
      } catch (err) {
        logger.error({ err, audience }, 'OneSignal payment-received push threw');
      }
    };

    await Promise.all([send(storeAdminBody, 'store_admin'), send(superAdminBody, 'super_admin')]);
  }

  /**
   * Push a "checkout abandoned" recovery alert to the store's admins +
   * super_admins. Fired from the payment-abandonment sweep the instant an order
   * is stamped as a high-intent gateway abandoner (the customer reached the
   * online payment page but never paid). The Enterprise `payment_abandonment`
   * feature is checked by the sweep before this is called, and the sweep's
   * `paymentGatewayAbandonedAt` stamp dedupes it to exactly once per order.
   *
   * This is the ONLY unpaid-online-order merchant alert: it deep-links to the
   * Payment Abandonments page (where the merchant re-sends the link / calls the
   * customer), not the order detail. Fire-and-forget — never throws to the
   * caller so a push glitch can't abort the sweep.
   */
  static async notifyAdminsOfAbandonedCheckout(input: NotifyOrderInput): Promise<void> {
    if (!isAdminConfigured()) {
      logger.warn(
        {
          hasAppId: !!config.onesignalAdminAppId,
          hasRestKey: !!config.onesignalAdminRestApiKey,
        },
        'Admin OneSignal not configured — skipping abandoned-checkout notification'
      );
      return;
    }

    // Deep-link to the retargeting UI (Payment Abandonments), not the order
    // detail — this alert is about recovering the sale, not viewing the order.
    const url = `${config.adminUrl}/stores/${input.storeId}/payment-abandonments`;
    const dataPayload = {
      type: 'order.checkout_abandoned',
      orderId: input.orderId,
      storeId: input.storeId,
      storeName: input.storeName,
    };
    const sharedFields = {
      app_id: config.onesignalAdminAppId,
      url,
      web_buttons: [{ id: 'recover-sale', text: 'Recover sale', url }],
      data: dataPayload,
    };

    const moneyText = formatMoney(input.total, input.currency);

    const [storeAdminPlayerIds, superAdminPlayerIds] = await Promise.all([
      this.getAdminPlayerIds({ role: 'store_admin', ownsStoreId: input.storeId }),
      this.getAdminPlayerIds({ role: 'super_admin', ownsStoreId: input.storeId }),
    ]);

    const storeAdminBody = {
      ...sharedFields,
      headings: { en: 'Checkout abandoned', ar: 'دفعة مهجورة — استرجع العميل' },
      contents: {
        en: `Order ${input.orderNumber} reached payment but wasn't completed — recover the sale`,
        ar: `الطلب ${input.orderNumber} وصل لصفحة الدفع ولم يكتمل — استرجع العملية`,
      },
      ...(storeAdminPlayerIds.length > 0
        ? { include_player_ids: storeAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }] }),
    };

    const superAdminBody = {
      ...sharedFields,
      headings: { en: 'Checkout abandoned', ar: 'دفعة مهجورة — استرجع العميل' },
      contents: {
        en: `${input.storeName} — Order ${input.orderNumber} (${moneyText}) reached payment but wasn't completed`,
        ar: `${input.storeName} — الطلب ${input.orderNumber} (${moneyText}) وصل لصفحة الدفع ولم يكتمل`,
      },
      ...(superAdminPlayerIds.length > 0
        ? { include_player_ids: superAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'role', relation: '=', value: 'super_admin' }] }),
    };

    const send = async (body: unknown, audience: 'store_admin' | 'super_admin') => {
      try {
        const res = await timedFetch('onesignal.send')(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Key ${config.onesignalAdminRestApiKey}`,
          },
          body: JSON.stringify(body),
        });
        const responseText = await res.text().catch(() => '');
        if (!res.ok) {
          logger.error(
            { status: res.status, body: responseText, audience },
            'OneSignal abandoned-checkout push failed'
          );
          return;
        }
        logger.info({ audience }, 'OneSignal abandoned-checkout push sent');
      } catch (err) {
        logger.error({ err, audience }, 'OneSignal abandoned-checkout push threw');
      }
    };

    await Promise.all([send(storeAdminBody, 'store_admin'), send(superAdminBody, 'super_admin')]);
  }

  /**
   * Push a payment-failure notification to admins of the store + super_admins.
   * Fired from PaymentService.handleWebhook on status: failed / expired /
   * cancelled. Customer is NOT notified — they see the failure inline at the
   * gateway / on the checkout error page.
   */
  static async notifyAdminsOfPaymentFailure(
    input: NotifyOrderInput & { reason?: string }
  ): Promise<void> {
    if (!isAdminConfigured()) {
      logger.warn(
        {
          hasAppId: !!config.onesignalAdminAppId,
          hasRestKey: !!config.onesignalAdminRestApiKey,
        },
        'Admin OneSignal not configured — skipping payment-failure notification'
      );
      return;
    }

    const url = adminOrderUrl(input.storeId, input.orderId);
    const dataPayload = {
      type: 'order.payment_failed',
      orderId: input.orderId,
      storeId: input.storeId,
      storeName: input.storeName,
      reason: input.reason,
    };
    const sharedFields = {
      app_id: config.onesignalAdminAppId,
      url,
      web_buttons: [{ id: 'view-order', text: 'View order', url }],
      data: dataPayload,
    };
    const moneyText = formatMoney(input.total, input.currency);
    const reasonSuffix = input.reason ? ` (${input.reason})` : '';

    const [storeAdminPlayerIds, superAdminPlayerIds] = await Promise.all([
      this.getAdminPlayerIds({ role: 'store_admin', ownsStoreId: input.storeId }),
      this.getAdminPlayerIds({ role: 'super_admin', ownsStoreId: input.storeId }),
    ]);

    const storeAdminBody = {
      ...sharedFields,
      headings: { en: 'Payment failed', ar: 'فشل الدفع' },
      contents: {
        en: `${input.orderNumber} — ${input.customerName} — ${moneyText}${reasonSuffix}`,
        ar: `${input.orderNumber} — ${input.customerName} — ${moneyText}${reasonSuffix}`,
      },
      ...(storeAdminPlayerIds.length > 0
        ? { include_player_ids: storeAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }] }),
    };

    const superAdminBody = {
      ...sharedFields,
      headings: { en: 'Payment failed', ar: 'فشل الدفع' },
      contents: {
        en: `${input.storeName} — ${input.orderNumber} — ${moneyText}${reasonSuffix}`,
        ar: `${input.storeName} — ${input.orderNumber} — ${moneyText}${reasonSuffix}`,
      },
      ...(superAdminPlayerIds.length > 0
        ? { include_player_ids: superAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'role', relation: '=', value: 'super_admin' }] }),
    };

    const send = async (body: unknown, audience: 'store_admin' | 'super_admin') => {
      try {
        const res = await timedFetch('onesignal.send')(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Key ${config.onesignalAdminRestApiKey}`,
          },
          body: JSON.stringify(body),
        });
        const responseText = await res.text().catch(() => '');
        if (!res.ok) {
          logger.error(
            { status: res.status, body: responseText, audience },
            'OneSignal payment-failure push failed'
          );
          return;
        }
        logger.info({ audience }, 'OneSignal payment-failure push sent');
      } catch (err) {
        logger.error({ err, audience }, 'OneSignal payment-failure push threw');
      }
    };

    await Promise.all([send(storeAdminBody, 'store_admin'), send(superAdminBody, 'super_admin')]);
  }

  /**
   * Push a refund-issued notification to admins of the store + super_admins.
   * Fired from the order/refunded Inngest fan-out so every refund path
   * (gateway-driven, admin "Refund via provider", status-button) lands
   * the same merchant push. Customer notification rides the same fan-out
   * via EmailService.sendOrderRefunded.
   */
  static async notifyAdminsOfRefund(input: NotifyOrderInput & { reason?: string }): Promise<void> {
    if (!isAdminConfigured()) {
      logger.warn(
        {
          hasAppId: !!config.onesignalAdminAppId,
          hasRestKey: !!config.onesignalAdminRestApiKey,
        },
        'Admin OneSignal not configured — skipping refund notification'
      );
      return;
    }

    const url = adminOrderUrl(input.storeId, input.orderId);
    const dataPayload = {
      type: 'order.refunded',
      orderId: input.orderId,
      storeId: input.storeId,
      storeName: input.storeName,
      reason: input.reason,
    };
    const sharedFields = {
      app_id: config.onesignalAdminAppId,
      url,
      web_buttons: [{ id: 'view-order', text: 'View order', url }],
      data: dataPayload,
    };
    const moneyText = formatMoney(input.total, input.currency);
    const reasonSuffix = input.reason ? ` (${input.reason})` : '';

    const [storeAdminPlayerIds, superAdminPlayerIds] = await Promise.all([
      this.getAdminPlayerIds({ role: 'store_admin', ownsStoreId: input.storeId }),
      this.getAdminPlayerIds({ role: 'super_admin', ownsStoreId: input.storeId }),
    ]);

    const storeAdminBody = {
      ...sharedFields,
      headings: { en: 'Refund issued', ar: 'تم استرداد المبلغ' },
      contents: {
        en: `${input.orderNumber} — ${input.customerName} — ${moneyText}${reasonSuffix}`,
        ar: `${input.orderNumber} — ${input.customerName} — ${moneyText}${reasonSuffix}`,
      },
      ...(storeAdminPlayerIds.length > 0
        ? { include_player_ids: storeAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }] }),
    };

    const superAdminBody = {
      ...sharedFields,
      headings: { en: 'Refund issued', ar: 'تم استرداد المبلغ' },
      contents: {
        en: `${input.storeName} — ${input.orderNumber} — ${moneyText}${reasonSuffix}`,
        ar: `${input.storeName} — ${input.orderNumber} — ${moneyText}${reasonSuffix}`,
      },
      ...(superAdminPlayerIds.length > 0
        ? { include_player_ids: superAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'role', relation: '=', value: 'super_admin' }] }),
    };

    const send = async (body: unknown, audience: 'store_admin' | 'super_admin') => {
      try {
        const res = await timedFetch('onesignal.send')(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Key ${config.onesignalAdminRestApiKey}`,
          },
          body: JSON.stringify(body),
        });
        const responseText = await res.text().catch(() => '');
        if (!res.ok) {
          logger.error(
            { status: res.status, body: responseText, audience },
            'OneSignal refund push failed'
          );
          return;
        }
        logger.info({ audience }, 'OneSignal refund push sent');
      } catch (err) {
        logger.error({ err, audience }, 'OneSignal refund push threw');
      }
    };

    await Promise.all([send(storeAdminBody, 'store_admin'), send(superAdminBody, 'super_admin')]);
  }

  /**
   * InstaPay manual orders (SP6a): tell the store's admins an order is waiting for
   * them to confirm the transfer (`awaiting`), or that the hold ran out and the
   * order was cancelled (`expired`). Store admins only: the money question is the
   * merchant's, not the platform's.
   */
  static async notifyAdminsOfInstapay(
    input: Omit<NotifyOrderInput, 'customerName' | 'paymentMethod'> & {
      kind: 'awaiting' | 'expired' | 'proof_submitted';
    }
  ): Promise<void> {
    if (!isAdminConfigured()) {
      logger.warn('Admin OneSignal not configured — skipping InstaPay notification');
      return;
    }
    const url = adminOrderUrl(input.storeId, input.orderId);
    const moneyText = formatMoney(input.total, input.currency);
    const awaiting = input.kind === 'awaiting';
    const proof = input.kind === 'proof_submitted';
    const storeAdminPlayerIds = await this.getAdminPlayerIds({
      role: 'store_admin',
      ownsStoreId: input.storeId,
    });
    const body = {
      app_id: config.onesignalAdminAppId,
      url,
      web_buttons: [{ id: 'view-order', text: 'View order', url }],
      data: {
        type: proof
          ? 'order.instapay_proof_submitted'
          : awaiting
            ? 'order.instapay_awaiting'
            : 'order.instapay_expired',
        orderId: input.orderId,
        storeId: input.storeId,
        storeName: input.storeName,
      },
      headings: proof
        ? { en: 'InstaPay receipt to review', ar: 'إيصال إنستاباي بانتظار المراجعة' }
        : awaiting
          ? { en: 'InstaPay transfer to confirm', ar: 'تحويل إنستاباي بانتظار التأكيد' }
          : { en: 'InstaPay order expired', ar: 'انتهت مهلة طلب إنستاباي' },
      contents: proof
        ? {
            en: `${input.orderNumber} — ${moneyText}. The shopper uploaded the transfer receipt. Check it and approve or reject.`,
            ar: `${input.orderNumber} — ${moneyText}. العميل رفع إيصال التحويل. راجعه ثم وافق أو ارفض.`,
          }
        : awaiting
          ? {
              en: `${input.orderNumber} — ${moneyText}. Confirm once the transfer arrives.`,
              ar: `${input.orderNumber} — ${moneyText}. أكّد الطلب بمجرد وصول التحويل.`,
            }
          : {
              en: `${input.orderNumber} — ${moneyText}. No confirmation in time: cancelled, stock released.`,
              ar: `${input.orderNumber} — ${moneyText}. لم يتم التأكيد في الوقت المحدد: أُلغي الطلب وأُعيد المخزون.`,
            },
      ...(storeAdminPlayerIds.length > 0
        ? { include_player_ids: storeAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }] }),
    };
    try {
      const res = await timedFetch('onesignal.send')(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${config.onesignalAdminRestApiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logger.error({ status: res.status, kind: input.kind }, 'OneSignal InstaPay push failed');
      }
    } catch (err) {
      logger.error({ err, kind: input.kind }, 'OneSignal InstaPay push threw');
    }
  }

  /**
   * Shipping (SP7): tell the store's admins a carrier booking failed for good (after the
   * automatic retries), so they can fix the cause (credentials, address, COD support) or ship
   * the order by hand. The order itself is already placed and unaffected.
   */
  static async notifyAdminsOfShipmentFailure(input: {
    storeId: string;
    storeName: string;
    orderId: string;
    orderNumber: string;
    carrier: string;
    reason: string;
  }): Promise<void> {
    if (!isAdminConfigured()) {
      logger.warn('Admin OneSignal not configured — skipping shipment failure notification');
      return;
    }
    const url = adminOrderUrl(input.storeId, input.orderId);
    const storeAdminPlayerIds = await this.getAdminPlayerIds({
      role: 'store_admin',
      ownsStoreId: input.storeId,
    });
    const body = {
      app_id: config.onesignalAdminAppId,
      url,
      web_buttons: [{ id: 'view-order', text: 'View order', url }],
      data: {
        type: 'order.shipment_failed',
        orderId: input.orderId,
        storeId: input.storeId,
        storeName: input.storeName,
      },
      headings: { en: 'Shipment not booked', ar: 'لم يتم حجز الشحنة' },
      contents: {
        en: `${input.orderNumber}: ${input.carrier} could not book this order (${input.reason}). Open the order to retry or ship it manually.`,
        ar: `${input.orderNumber}: تعذّر حجز الشحنة لدى ${input.carrier} (${input.reason}). افتح الطلب لإعادة المحاولة أو الشحن يدويًا.`,
      },
      ...(storeAdminPlayerIds.length > 0
        ? { include_player_ids: storeAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }] }),
    };
    try {
      const res = await timedFetch('onesignal.send')(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${config.onesignalAdminRestApiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logger.error({ status: res.status }, 'OneSignal shipment failure push failed');
      }
    } catch (err) {
      logger.error({ err }, 'OneSignal shipment failure push threw');
    }
  }

  /**
   * B2B: tell the store's admins a wholesale account application is waiting (new application, or the 48h nudge).
   * Best-effort like every push here: a failure is logged and never reaches the caller.
   */
  static async notifyAdminsOfWholesaleApplication(input: {
    storeId: string;
    kind: 'received' | 'nudge';
    pendingCount: number;
    businessName?: string;
  }): Promise<void> {
    if (!isAdminConfigured()) {
      logger.warn('Admin OneSignal not configured - skipping wholesale application notification');
      return;
    }
    const url = `${config.adminUrl}/stores/${input.storeId}/wholesale-applications`;
    const storeAdminPlayerIds = await this.getAdminPlayerIds({
      role: 'store_admin',
      ownsStoreId: input.storeId,
    });
    const received = input.kind === 'received';
    const body = {
      app_id: config.onesignalAdminAppId,
      url,
      data: { type: 'wholesale.application.received', storeId: input.storeId },
      headings: received
        ? { en: 'New wholesale application', ar: 'طلب جملة جديد' }
        : { en: 'Wholesale applications waiting', ar: 'طلبات جملة مستنية ردك' },
      contents: received
        ? {
            en: `${input.businessName ?? 'A buyer'} applied for a wholesale account. ${input.pendingCount} waiting.`,
            ar: `${input.businessName ?? 'عميل'} قدّم على حساب جملة. فيه ${input.pendingCount} طلب مستني.`,
          }
        : {
            en: `${input.pendingCount} wholesale application(s) have waited over 48 hours.`,
            ar: `فيه ${input.pendingCount} طلب جملة مستني ردك بقاله أكتر من 48 ساعة.`,
          },
      ...(storeAdminPlayerIds.length > 0
        ? { include_player_ids: storeAdminPlayerIds }
        : { filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }] }),
    };
    try {
      const res = await timedFetch('onesignal.send')(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${config.onesignalAdminRestApiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        logger.error({ status: res.status }, 'OneSignal wholesale application push failed');
    } catch (err) {
      logger.error({ err }, 'OneSignal wholesale application push threw');
    }
  }

  /**
   * Resolve the OneSignal player_ids for a given admin audience by
   * joining `User` (filtered by role / store ownership) against
   * `OneSignalSubscription`. Used by `notifyAdminsOfOrder` to target
   * pushes by stored player_id instead of fragile client-side tags.
   *
   * Returns a deduplicated, non-empty list. Empty result means no
   * subscribed devices match — the caller falls back to tag filtering.
   */
  private static async getAdminPlayerIds(criteria: {
    role: 'super_admin' | 'store_admin';
    ownsStoreId?: string;
  }): Promise<string[]> {
    // The audience is users OUTSIDE the store scope the notification runs in (the
    // owner's and the super_admins' rows have store_id NULL) and their device rows
    // are user-keyed, so neither `users` nor `onesignal_subscriptions` can be read
    // here under strict RLS + the tenant guard. The `ebda_admin_push_player_ids`
    // definer returns device ids only; a store_admin audience is answered only for
    // the store the transaction is scoped to, hence `withStore` (it reuses the
    // caller's transaction when it is already that store's).
    if (criteria.role === 'store_admin') {
      if (!criteria.ownsStoreId) return [];
      const storeId = criteria.ownsStoreId;
      return withStore(storeId, () => adminPushPlayerIds('store_admin', storeId));
    }
    // The super_admin audience is answered only to a scoped caller: run it in the
    // notification's store scope (reused when the caller is already in it).
    if (!criteria.ownsStoreId) return [];
    return withStore(criteria.ownsStoreId, () => adminPushPlayerIds('super_admin', null));
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
    // User-keyed rows (RLS on app.current_user_id): written AS the user.
    await withUser(userId, tx =>
      tx.oneSignalSubscription.upsert({
        where: { userId_playerId: { userId, playerId } },
        create: { userId, playerId, deviceLabel },
        update: { deviceLabel },
      })
    );
  }

  static async listSubscriptions(userId: string) {
    return withUser(userId, tx =>
      tx.oneSignalSubscription.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
      })
    );
  }

  static async deleteSubscription(userId: string, playerId: string): Promise<void> {
    await withUser(userId, tx =>
      tx.oneSignalSubscription.delete({ where: { userId_playerId: { userId, playerId } } })
    ).catch(err => {
      // not-found is fine — the user may have already removed it elsewhere
      if (err?.code !== 'P2025') throw err;
    });
  }

  /**
   * Public surface for "is the OneSignal integration usable right now".
   * Routes use this to short-circuit with a 503 PUSH_NOT_CONFIGURED rather
   * than calling OneSignal with empty credentials and confusing the merchant
   * with a generic 500.
   */
  static isConfigured(): boolean {
    return isConfigured();
  }

  /**
   * Send a tenant-scoped broadcast to every storefront device that has
   * tagged itself with `storeId = <input.storeId>`. The filter is enforced
   * server-side here — never trust a tag claim from a client. Other tenants'
   * subscribers will not receive this notification because their tag value
   * differs.
   *
   * Throws `OneSignalNotConfiguredError` (503 PUSH_NOT_CONFIGURED) when env
   * vars are missing, and `OneSignalRequestError` for non-2xx responses so
   * the route handler can surface a real error to the admin UI.
   */
  static async broadcastToStore(input: BroadcastInput): Promise<BroadcastResult> {
    if (!isConfigured()) {
      throw new OneSignalNotConfiguredError();
    }

    const body: Record<string, unknown> = {
      app_id: config.onesignalAppId,
      headings: { en: input.titleEn, ar: input.titleAr },
      contents: { en: input.bodyEn, ar: input.bodyAr },
      // Per-store filter — DO NOT remove. This is what prevents a broadcast
      // for tenant A from leaking to tenant B's subscribers.
      filters: [{ field: 'tag', key: 'storeId', relation: '=', value: input.storeId }],
    };
    if (input.url) {
      body.url = input.url;
    }

    const res = await timedFetch('onesignal.send')(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Match `notifyAdminsOfOrder`'s auth scheme — `Key <REST>` is the
        // current OneSignal v2 form and what the existing helper uses.
        Authorization: `Key ${config.onesignalRestApiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.error({ status: res.status, body: errBody }, 'OneSignal broadcast failed');
      throw new OneSignalRequestError(res.status, errBody);
    }

    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      recipients?: number;
      errors?: unknown;
    };
    return {
      id: json.id || '',
      recipients: typeof json.recipients === 'number' ? json.recipients : 0,
    };
  }

  /**
   * Pull the last N notifications from OneSignal and filter to ones whose
   * `filters` array references this store. OneSignal doesn't support
   * server-side tag filtering on the list endpoint, so we fetch a generous
   * window and filter locally. We rely on the `filters` array we wrote in
   * `broadcastToStore` to identify the tenant — that's the same source of
   * truth used for delivery scoping, so it's already authoritative.
   */
  static async listRecentBroadcasts(storeId: string, limit = 10): Promise<BroadcastSummary[]> {
    if (!isConfigured()) {
      throw new OneSignalNotConfiguredError();
    }

    // Pull a wider window so cross-tenant chatter doesn't crowd this store
    // out of the list. 50 is plenty for a small/mid platform; bump if it
    // ever stops returning enough rows for an active tenant.
    const fetchLimit = Math.max(50, limit * 5);
    const url = `${ENDPOINT}?app_id=${encodeURIComponent(
      config.onesignalAppId
    )}&limit=${fetchLimit}&kind=0`;

    const res = await timedFetch('onesignal.send')(url, {
      method: 'GET',
      headers: {
        Authorization: `Key ${config.onesignalRestApiKey}`,
      },
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.error({ status: res.status, body: errBody }, 'OneSignal list broadcasts failed');
      throw new OneSignalRequestError(res.status, errBody);
    }

    const json = (await res.json().catch(() => ({}))) as {
      notifications?: Array<Record<string, unknown>>;
    };

    const notifications = Array.isArray(json.notifications) ? json.notifications : [];
    const matches: BroadcastSummary[] = [];

    for (const n of notifications) {
      const filters = (n.filters as Array<Record<string, unknown>> | undefined) || [];
      const matchesStore = filters.some(
        f => f && f.field === 'tag' && f.key === 'storeId' && f.value === storeId
      );
      if (!matchesStore) continue;

      matches.push({
        id: String(n.id || ''),
        headings: (n.headings as { en?: string; ar?: string } | undefined) || undefined,
        contents: (n.contents as { en?: string; ar?: string } | undefined) || undefined,
        url: typeof n.url === 'string' ? (n.url as string) : undefined,
        successful: typeof n.successful === 'number' ? (n.successful as number) : undefined,
        converted: typeof n.converted === 'number' ? (n.converted as number) : undefined,
        failed: typeof n.failed === 'number' ? (n.failed as number) : undefined,
        remaining: typeof n.remaining === 'number' ? (n.remaining as number) : undefined,
        queued_at: typeof n.queued_at === 'number' ? (n.queued_at as number) : undefined,
        send_after: typeof n.send_after === 'number' ? (n.send_after as number) : undefined,
        completed_at: typeof n.completed_at === 'number' ? (n.completed_at as number) : undefined,
      });
      if (matches.length >= limit) break;
    }

    return matches;
  }
}
