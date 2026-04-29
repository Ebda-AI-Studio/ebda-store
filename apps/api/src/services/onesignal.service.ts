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
  /** Payment method the customer chose at checkout (e.g. 'cod', 'knet',
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
    knet: 'KNET',
    visa: 'Visa',
    mastercard: 'Mastercard',
    apple_pay: 'Apple Pay',
    google_pay: 'Google Pay',
    benefit: 'Benefit',
    mada: 'Mada',
    stc_pay: 'STC Pay',
  };
  if (labels[normalized]) return labels[normalized];
  // Title-case fallback for unknown methods.
  return normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
 *  from merchants). Origin: https://store.forcemediakw.com. */
function isStorefrontConfigured(): boolean {
  return !!(config.onesignalAppId && config.onesignalRestApiKey);
}

/** Admin app — used by `notifyAdminsOfOrder` (new-order pings to store
 *  owners). Origin: https://app.forcemediakw.com. Distinct from the
 *  storefront app because OneSignal locks each app to a single origin. */
function isAdminConfigured(): boolean {
  return !!(config.onesignalAdminAppId && config.onesignalAdminRestApiKey);
}

// Backwards-compat alias for code paths not yet split into admin vs storefront.
function isConfigured(): boolean {
  return isStorefrontConfigured();
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
    // Admin pushes go through the admin OneSignal app (origin
    // app.forcemediakw.com), NOT the storefront app. OneSignal locks each
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

    // Two distinct pushes so each audience gets the body that's most
    // useful to them. OneSignal sends one body per API call, so we split.
    //
    //  - store_admins for THIS store want operational detail: which order,
    //    which customer, how much.
    //  - super_admins manage every store and need triage info: WHICH
    //    store the order came from + amount + payment method (so they
    //    can spot a COD spike on tenant X without opening the dashboard).
    //
    // Tag layout (set in apps/admin/src/components/OneSignalInit.tsx):
    //   store_admin devices  -> tag store_id = <their store>, role = store_admin
    //   super_admin devices  -> tag role = super_admin (NO store_id tag)
    // So `tag:store_id = X` matches store_admins for store X exclusively
    // and `tag:role = super_admin` matches super_admins exclusively.

    const storeAdminBody = {
      ...sharedFields,
      headings: { en: 'New order', ar: 'طلب جديد' },
      contents: {
        en: `${input.orderNumber} from ${input.customerName} — ${moneyText}`,
        ar: `${input.orderNumber} من ${input.customerName} — ${moneyText}`,
      },
      filters: [{ field: 'tag', key: 'store_id', relation: '=', value: input.storeId }],
    };

    const superAdminBody = {
      ...sharedFields,
      headings: { en: 'New order', ar: 'طلب جديد' },
      contents: {
        en: `${input.storeName} — ${moneyText} · ${paymentLabel}`,
        ar: `${input.storeName} — ${moneyText} · ${paymentLabel}`,
      },
      filters: [{ field: 'tag', key: 'role', relation: '=', value: 'super_admin' }],
    };

    const send = async (body: unknown, audience: 'store_admin' | 'super_admin') => {
      try {
        const res = await fetch(ENDPOINT, {
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

    const res = await fetch(ENDPOINT, {
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

    const res = await fetch(url, {
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
