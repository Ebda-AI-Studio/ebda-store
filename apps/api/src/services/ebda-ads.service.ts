/**
 * Ebda's OWN acquisition tracking, server side (the platform funnel, not merchant storefronts:
 * those use pixels-capi.service.ts with each merchant's own pixel).
 *
 * Sends CompleteRegistration, StoreCreated and Purchase (first paid subscription) to the Meta
 * Conversions API for Ebda's pixel. Browser twins share the event_id (see
 * packages/shared/src/tracking/event-ids.ts), so Meta counts one conversion.
 *
 * Config (all optional; unset = the whole feature is a no-op, logged once):
 *   EBDA_META_PIXEL_ID            public pixel id (the browser reads NEXT_PUBLIC_EBDA_META_PIXEL_ID)
 *   EBDA_META_CAPI_TOKEN          secret Conversions API access token
 *   EBDA_META_TEST_EVENT_CODE     optional: routes events to Events Manager > Test events
 *   EBDA_POSTHOG_KEY              optional: public project key for the server-side `subscription_paid`
 *                                 (falls back to NEXT_PUBLIC_POSTHOG_KEY)
 *
 * PII: email and phone are normalised then SHA-256 hashed (Meta spec). Nothing is sent for an
 * account that did not consent to marketing tracking at signup.
 */
import crypto from 'crypto';
import { z } from 'zod/v3';
import {
  BRAND_STORE_APP_URL,
  normalizeEgyptianMobile,
  sanitizeAttribution,
  type EbdaAttribution,
} from '@ebda/shared';
import logger from '../lib/logger';
import { timedFetch } from '../lib/fetch-with-timeout';

// ─── Stored shape ────────────────────────────────────────────────────────────

/** What `users.acquisition` holds. Built by `buildAcquisition` from the signup request. */
export interface EbdaAcquisition {
  v: 1;
  attribution?: EbdaAttribution;
  fbp?: string;
  fbc?: string;
  phId?: string;
  consent: { analytics: boolean; marketing: boolean };
  /** The signup request's ip / user agent (server-observed, never client-supplied). */
  ip?: string;
  ua?: string;
  capturedAt: string;
}

const short = (max: number) => z.string().trim().max(max);

/** The `tracking` object the signup form sends. Every field is length-capped. */
export const signupTrackingSchema = z.object({
  attribution: z.unknown().optional(),
  fbp: short(120).optional(),
  fbc: short(240).optional(),
  phId: short(120).optional(),
  consent: z.object({ analytics: z.boolean(), marketing: z.boolean() }),
});
export type SignupTrackingInput = z.infer<typeof signupTrackingSchema>;

/**
 * Turn the signup `tracking` payload into the row to persist. Null when the visitor gave no
 * consent at all (nothing is stored). Marketing-only fields (ip, ua, fbp, fbc) are kept only
 * when marketing was allowed.
 */
export function buildAcquisition(
  tracking: SignupTrackingInput | undefined,
  req: { ip?: string; userAgent?: string },
  now: Date = new Date()
): EbdaAcquisition | null {
  if (!tracking) return null;
  const { analytics, marketing } = tracking.consent;
  if (!analytics && !marketing) return null;
  const attribution = sanitizeAttribution(tracking.attribution) ?? undefined;
  return {
    v: 1,
    ...(attribution ? { attribution } : {}),
    ...(marketing && tracking.fbp ? { fbp: tracking.fbp } : {}),
    ...(marketing && (tracking.fbc ?? attribution?.fbc)
      ? { fbc: tracking.fbc ?? attribution?.fbc }
      : {}),
    ...(analytics && tracking.phId ? { phId: tracking.phId } : {}),
    consent: { analytics, marketing },
    ...(marketing && req.ip ? { ip: req.ip.slice(0, 64) } : {}),
    ...(marketing && req.userAgent ? { ua: req.userAgent.slice(0, 400) } : {}),
    capturedAt: now.toISOString(),
  };
}

/** Read a stored value back defensively (it is a JSON column). */
export function readAcquisition(value: unknown): EbdaAcquisition | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const consent = o.consent as { analytics?: unknown; marketing?: unknown } | undefined;
  if (o.v !== 1 || !consent) return null;
  return {
    v: 1,
    attribution: sanitizeAttribution(o.attribution) ?? undefined,
    fbp: typeof o.fbp === 'string' ? o.fbp : undefined,
    fbc: typeof o.fbc === 'string' ? o.fbc : undefined,
    phId: typeof o.phId === 'string' ? o.phId : undefined,
    consent: { analytics: consent.analytics === true, marketing: consent.marketing === true },
    ip: typeof o.ip === 'string' ? o.ip : undefined,
    ua: typeof o.ua === 'string' ? o.ua : undefined,
    capturedAt: typeof o.capturedAt === 'string' ? o.capturedAt : '',
  };
}

/**
 * The part of an owner's acquisition record a super-admin sees on the store page. ip, user
 * agent and the Meta browser/click ids stay server-side.
 */
export function acquisitionForAdmin(owner: { acquisition?: unknown }) {
  const a = readAcquisition(owner.acquisition);
  if (!a) return null;
  return { attribution: a.attribution ?? null, consent: a.consent, capturedAt: a.capturedAt };
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface EbdaAdsConfig {
  pixelId: string;
  accessToken: string;
  testEventCode?: string;
}

/** Null when Ebda's own CAPI is not configured (both the id and the token are required). */
export function getEbdaAdsConfig(env: NodeJS.ProcessEnv = process.env): EbdaAdsConfig | null {
  const pixelId = env.EBDA_META_PIXEL_ID?.trim();
  const accessToken = env.EBDA_META_CAPI_TOKEN?.trim();
  if (!pixelId || !accessToken) return null;
  return {
    pixelId,
    accessToken,
    testEventCode: env.EBDA_META_TEST_EVENT_CODE?.trim() || undefined,
  };
}

let loggedUnset = false;
/** One info line per process when the feature is off. Returns the config (or null). */
export function ebdaAdsConfigOrLog(env: NodeJS.ProcessEnv = process.env): EbdaAdsConfig | null {
  const cfg = getEbdaAdsConfig(env);
  if (!cfg && !loggedUnset) {
    loggedUnset = true;
    logger.info(
      '[ebda-ads] EBDA_META_PIXEL_ID / EBDA_META_CAPI_TOKEN not set — own-ads conversions are a no-op'
    );
  }
  return cfg;
}
/** Test seam. */
export function resetEbdaAdsLogForTests(): void {
  loggedUnset = false;
}

// ─── Hashing (Meta customer-information-parameters spec) ─────────────────────

export const sha256Hex = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/** Lowercase + trim, then SHA-256. Empty -> null. */
export function hashEmailForMeta(email: string | null | undefined): string | null {
  const v = email?.trim().toLowerCase();
  return v ? sha256Hex(v) : null;
}

/**
 * Meta wants digits only, country code included, no '+', no leading zeros. An Egyptian mobile
 * is canonicalised to E.164 first (01012345678 -> 201012345678); anything else keeps its digits.
 */
export function normalizePhoneForMeta(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const e164 = normalizeEgyptianMobile(phone);
  const digits = (e164 ?? phone).replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 7 ? digits : null;
}
export function hashPhoneForMeta(phone: string | null | undefined): string | null {
  const n = normalizePhoneForMeta(phone);
  return n ? sha256Hex(n) : null;
}

// ─── Payload ─────────────────────────────────────────────────────────────────

export type EbdaAdsEventName = 'CompleteRegistration' | 'StoreCreated' | 'Purchase';

export interface EbdaAdsEventInput {
  name: EbdaAdsEventName;
  /** Dedup id shared with the browser event (shared/tracking/event-ids.ts). */
  eventId: string;
  userId: string;
  email: string;
  phone?: string | null;
  acquisition: EbdaAcquisition;
  /** Purchase only: major units (EGP), already divided by 100. */
  value?: number;
  currency?: string;
  planCode?: string;
  now?: Date;
}

const SOURCE_PATH: Record<EbdaAdsEventName, string> = {
  CompleteRegistration: '/verify-email',
  StoreCreated: '/onboarding',
  Purchase: '/billing',
};

export function buildEbdaCapiEvent(input: EbdaAdsEventInput) {
  const a = input.acquisition;
  const em = hashEmailForMeta(input.email);
  const ph = hashPhoneForMeta(input.phone);
  const user_data: Record<string, unknown> = {
    ...(em ? { em: [em] } : {}),
    ...(ph ? { ph: [ph] } : {}),
    external_id: [sha256Hex(input.userId)],
    country: [sha256Hex('eg')],
    ...(a.fbp ? { fbp: a.fbp } : {}),
    ...(a.fbc ? { fbc: a.fbc } : {}),
    ...(a.ip ? { client_ip_address: a.ip } : {}),
    ...(a.ua ? { client_user_agent: a.ua } : {}),
  };
  const custom_data: Record<string, unknown> = {
    ...(a.attribution?.utm_source ? { utm_source: a.attribution.utm_source } : {}),
    ...(a.attribution?.utm_campaign ? { utm_campaign: a.attribution.utm_campaign } : {}),
  };
  if (input.name === 'Purchase') {
    custom_data.value = input.value ?? 0;
    custom_data.currency = input.currency ?? 'EGP';
    if (input.planCode) {
      custom_data.content_name = input.planCode;
      custom_data.content_type = 'product';
    }
  }
  return {
    event_name: input.name,
    event_time: Math.floor((input.now ?? new Date()).getTime() / 1000),
    event_id: input.eventId,
    action_source: 'website' as const,
    event_source_url: `${BRAND_STORE_APP_URL}${SOURCE_PATH[input.name]}`,
    user_data,
    custom_data,
  };
}

// ─── Send ────────────────────────────────────────────────────────────────────

const META_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v21.0';

export type SendResult =
  | { sent: true }
  | { sent: false; reason: 'unconfigured' | 'no_marketing_consent' };

/**
 * POST one event to Ebda's pixel. Throws on a non-2xx or when Meta did not take the event, so
 * the Inngest function retries; the caller decides what a final failure means. Form-encoded
 * with the token in the body (not the URL), same transport as pixels-capi.service.ts.
 */
export async function sendEbdaCapiEvent(
  input: EbdaAdsEventInput,
  deps: { config?: EbdaAdsConfig | null; fetchImpl?: typeof fetch } = {}
): Promise<SendResult> {
  const cfg = deps.config === undefined ? ebdaAdsConfigOrLog() : deps.config;
  if (!cfg) return { sent: false, reason: 'unconfigured' };
  if (!input.acquisition.consent.marketing) return { sent: false, reason: 'no_marketing_consent' };

  const form = new URLSearchParams({
    data: JSON.stringify([buildEbdaCapiEvent(input)]),
    access_token: cfg.accessToken,
  });
  if (cfg.testEventCode) form.set('test_event_code', cfg.testEventCode);

  const res = await (deps.fetchImpl ?? timedFetch('meta.capi'))(
    `https://graph.facebook.com/${META_API_VERSION}/${cfg.pixelId}/events`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Meta CAPI responded ${res.status} for ${input.name}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { events_received?: number };
  if (json.events_received !== 1) {
    throw new Error(
      `Meta CAPI accepted ${input.name} but reported events_received=${String(json.events_received)}`
    );
  }
  logger.info(
    { event: input.name, eventId: input.eventId, testMode: !!cfg.testEventCode },
    '[ebda-ads] conversion sent'
  );
  return { sent: true };
}

/** Server-side PostHog capture for the step the browser cannot see (a confirmed payment). */
export async function capturePostHogServer(
  args: { distinctId: string; event: string; properties: Record<string, unknown> },
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const key = env.EBDA_POSTHOG_KEY?.trim() || env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (!key) return false;
  const host = env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || 'https://eu.i.posthog.com';
  const res = await (deps.fetchImpl ?? timedFetch('posthog.capture'))(`${host}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      event: args.event,
      distinct_id: args.distinctId,
      properties: args.properties,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PostHog capture responded ${res.status}`);
  return true;
}
