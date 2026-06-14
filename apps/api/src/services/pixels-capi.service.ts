/**
 * Server-Side Conversion API (CAPI) Service
 *
 * Sends Purchase conversion events to Meta Conversions API and TikTok Events API
 * from the server side. This fires independently of the browser pixel and reaches
 * Meta/TikTok even when an ad-blocker or iOS ITP strips the client-side event.
 *
 * PII HANDLING — NEVER send raw email or phone to Meta/TikTok:
 *   - email: lowercased, trimmed, then SHA-256 hashed (Meta spec §user_data)
 *   - phone: digits-only E.164, then SHA-256 hashed
 *
 * DEDUPLICATION:
 *   event_id = order.id (UUID). The client-side Purchase event in SuccessClient
 *   also passes this same orderId as eventID so Meta/TikTok deduplicate the pair
 *   and count one conversion regardless of which signal arrived first.
 *
 * FAIL-OPEN:
 *   All errors are logged but never rethrown. A CAPI failure must never block or
 *   fail the order or the Inngest step that calls us.
 *
 * NOTE ON ENCRYPTION:
 *   The marketingPixels JSON blob stores accessToken in plaintext (not encrypted
 *   at-rest like wbsApiKey). The mask is display-only. Reading from the DB row
 *   gives the real token directly.
 */

import crypto from 'crypto';
import logger from '../lib/logger';

// ─── Hashing helpers ─────────────────────────────────────────────────────────

/**
 * SHA-256 hash a string for safe transmission to advertising platforms.
 * Returns lowercase hex — the format Meta and TikTok both require.
 */
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Normalise an email address and hash it.
 * Meta spec: lowercase + trim before hashing.
 */
export function hashEmail(email: string): string {
  return sha256(email.toLowerCase().trim());
}

/**
 * Normalise a phone number and hash it.
 * Meta spec: digits only, E.164 (strip spaces, dashes, parens, leading zeros).
 * We keep the leading "+" if present — Meta accepts +digits or digits-only.
 */
export function hashPhone(phone: string): string {
  // Retain leading + for E.164, strip everything else non-numeric
  const normalised = phone.replace(/[^\d+]/g, '');
  return sha256(normalised);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MarketingPixelConfig {
  enabled: boolean;
  pixelId: string;
  accessToken?: string;
  testEventCode?: string;
}

interface MarketingPixelsJson {
  meta?: MarketingPixelConfig;
  tiktok?: MarketingPixelConfig;
  [key: string]: unknown;
}

export interface PurchaseOrderData {
  id: string; // orderId — used as event_id for deduplication
  total: number; // stored as integer milliKWD (e.g. 5000 = 5.000 KWD)
  currency: string;
  customer?: {
    email?: string | null;
    phone?: string | null;
  } | null;
  shippingAddress?: Record<string, unknown> | null;
}

// ─── Meta CAPI ───────────────────────────────────────────────────────────────

const META_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v21.0';

interface MetaCAPIPayload {
  data: Array<{
    event_name: string;
    event_time: number;
    event_id: string;
    action_source: string;
    event_source_url?: string;
    user_data: {
      em?: string[];
      ph?: string[];
    };
    custom_data: {
      currency: string;
      value: number;
    };
  }>;
  test_event_code?: string;
}

/**
 * POST a Purchase event to the Meta Conversions API for a given pixel.
 */
async function sendMetaCAPI(
  pixelId: string,
  accessToken: string,
  order: PurchaseOrderData,
  storeUrl: string,
  testEventCode?: string
): Promise<void> {
  const email = order.customer?.email
    ? String(order.customer.email)
    : typeof order.shippingAddress?.email === 'string'
      ? order.shippingAddress.email
      : null;

  const phone = order.customer?.phone
    ? String(order.customer.phone)
    : typeof order.shippingAddress?.phone === 'string'
      ? order.shippingAddress.phone
      : null;

  const userData: { em?: string[]; ph?: string[] } = {};
  if (email && email.trim()) userData.em = [hashEmail(email)];
  if (phone && phone.trim()) userData.ph = [hashPhone(phone)];

  // total is stored as milliunits (e.g. 5000 = KWD 5.000). Divide by 1000
  // to get the decimal value Meta expects.
  const value = order.total / 1000;

  const payload: MetaCAPIPayload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: order.id,
        action_source: 'website',
        event_source_url: storeUrl,
        user_data: userData,
        custom_data: {
          currency: order.currency || 'KWD',
          value,
        },
      },
    ],
  };

  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events?access_token=${accessToken}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(
      `Meta CAPI responded ${response.status} for pixel ${pixelId}: ${body.slice(0, 200)}`
    );
  }

  const json = (await response.json()) as { events_received?: number };
  logger.info(
    { orderId: order.id, pixelId, eventsReceived: json.events_received },
    '[pixels-capi] meta purchase event sent'
  );
}

// ─── TikTok Events API ────────────────────────────────────────────────────────

const TIKTOK_EVENTS_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

interface TikTokEventPayload {
  pixel_code: string;
  event: string;
  event_time: number;
  event_id: string;
  properties: {
    currency: string;
    value: number;
  };
  context: {
    user?: {
      email?: string;
      phone_number?: string;
    };
    page?: {
      url?: string;
    };
  };
  test_event_code?: string;
}

/**
 * POST a CompletePayment event to the TikTok Events API for a given pixel.
 * TikTok's purchase event is called "CompletePayment" (matches the client-side ttq name).
 */
async function sendTikTokCAPI(
  pixelId: string,
  accessToken: string,
  order: PurchaseOrderData,
  storeUrl: string,
  testEventCode?: string
): Promise<void> {
  const email = order.customer?.email
    ? String(order.customer.email)
    : typeof order.shippingAddress?.email === 'string'
      ? order.shippingAddress.email
      : null;

  const phone = order.customer?.phone
    ? String(order.customer.phone)
    : typeof order.shippingAddress?.phone === 'string'
      ? order.shippingAddress.phone
      : null;

  const user: TikTokEventPayload['context']['user'] = {};
  if (email && email.trim()) user.email = hashEmail(email);
  if (phone && phone.trim()) user.phone_number = hashPhone(phone);

  const value = order.total / 1000;

  const payload: TikTokEventPayload = {
    pixel_code: pixelId,
    event: 'CompletePayment',
    event_time: Math.floor(Date.now() / 1000),
    event_id: order.id,
    properties: {
      currency: order.currency || 'KWD',
      value,
    },
    context: {
      user,
      page: { url: storeUrl },
    },
  };

  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  const response = await fetch(TIKTOK_EVENTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': accessToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(
      `TikTok Events API responded ${response.status} for pixel ${pixelId}: ${body.slice(0, 200)}`
    );
  }

  const json = (await response.json()) as { code?: number; message?: string };
  if (json.code !== 0) {
    throw new Error(`TikTok Events API error code ${json.code}: ${json.message ?? 'unknown'}`);
  }

  logger.info({ orderId: order.id, pixelId }, '[pixels-capi] tiktok purchase event sent');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send server-side Purchase conversion events to every configured platform
 * (currently Meta CAPI and TikTok Events API).
 *
 * Always fail-open: errors are caught, logged, and discarded so a failing CAPI
 * call never surfaces as a step failure in Inngest.
 *
 * @param marketingPixels  Raw marketingPixels JSON from the Store DB row (unmasked,
 *                         directly from `prisma.store.findUnique`).
 * @param order            Minimal order data needed to build the event payload.
 * @param storeUrl         Public-facing storefront URL (used as event_source_url).
 */
export async function sendPurchaseConversion(
  marketingPixels: unknown,
  order: PurchaseOrderData,
  storeUrl: string
): Promise<void> {
  if (!marketingPixels || typeof marketingPixels !== 'object') return;

  const pixels = marketingPixels as MarketingPixelsJson;

  // ── Meta ────────────────────────────────────────────────────────────────────
  const meta = pixels.meta;
  if (
    meta?.enabled &&
    meta.pixelId &&
    meta.accessToken &&
    !meta.accessToken.includes('****') // reject any accidentally-stored mask
  ) {
    try {
      await sendMetaCAPI(meta.pixelId, meta.accessToken, order, storeUrl, meta.testEventCode);
    } catch (err) {
      // fail-open: log + continue
      logger.error(
        { err, orderId: order.id, pixelId: meta.pixelId },
        '[pixels-capi] meta capi send failed — failing open'
      );
    }
  }

  // ── TikTok ──────────────────────────────────────────────────────────────────
  const tiktok = pixels.tiktok;
  if (
    tiktok?.enabled &&
    tiktok.pixelId &&
    tiktok.accessToken &&
    !tiktok.accessToken.includes('****')
  ) {
    try {
      await sendTikTokCAPI(
        tiktok.pixelId,
        tiktok.accessToken,
        order,
        storeUrl,
        tiktok.testEventCode
      );
    } catch (err) {
      // fail-open
      logger.error(
        { err, orderId: order.id, pixelId: tiktok.pixelId },
        '[pixels-capi] tiktok events api send failed — failing open'
      );
    }
  }
}
