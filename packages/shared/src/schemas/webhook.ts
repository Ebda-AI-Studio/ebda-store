import { z } from 'zod/v3';
import { isBrandHost } from '../brand';

/**
 * Merchant OUTGOING webhooks: the contracts shared by the API
 * (`apps/api/src/routes/merchant-webhooks.routes.ts`) and the admin page
 * (`apps/admin/src/app/stores/[id]/webhooks`). Plan: docs/plans/done/2026-10-21-merchant-webhooks.md.
 * Receiver documentation: apps/docs/content/merchant-webhooks.mdx.
 */

export const WEBHOOK_EVENT_TYPES = [
  'order.created',
  'order.paid',
  'order.status_changed',
  'order.refunded',
  'product.created',
  'product.updated',
  'product.deleted',
  'inventory.low',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Event type of the admin "send test event" button; not subscribable. */
export const WEBHOOK_TEST_EVENT = 'webhook.test' as const;

/** Bumped only for a breaking payload change; additive fields do not bump it. */
export const WEBHOOK_PAYLOAD_VERSION = '2026-10-21';

/** `order.status_changed` is sent for these statuses only. */
export const WEBHOOK_ORDER_STATUSES = ['shipped', 'delivered', 'cancelled'] as const;

/** Total tries per delivery and the wait BEFORE each try (first is immediate): about 24h overall. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_RETRY_DELAYS_SEC = [0, 60, 600, 3600, 21_600, 61_200] as const;
/** A delivery that exhausted every attempt counts once; this many in a row disables the endpoint. */
export const WEBHOOK_CONSECUTIVE_FAILURE_LIMIT = 10;
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Receivers should reject a signature older than this (replay window). */
export const WEBHOOK_TOLERANCE_SEC = 300;
export const WEBHOOK_MAX_ENDPOINTS_PER_STORE = 10;
export const WEBHOOK_LOG_KEEP_PER_ENDPOINT = 50;
export const WEBHOOK_LOG_RETENTION_DAYS = 30;
export const WEBHOOK_RESPONSE_SNIPPET_CHARS = 200;
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Plan gate (Ruling WH-1): Growth + Business. */
export const WEBHOOK_PLAN_CODES: readonly string[] = ['growth', 'business'];
export function planIncludesWebhooks(code: string): boolean {
  return WEBHOOK_PLAN_CODES.includes(code);
}

/** The URL's SHAPE only (https, no credentials, no IP literal). Reachability is the API's job. */
export function webhookUrlShapeError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not_a_url';
  }
  if (u.protocol !== 'https:') return 'https_required';
  if (u.username || u.password) return 'credentials_not_allowed';
  // HTTPS on 443 only (the parser drops an explicit :443, so any remaining port is another one).
  if (u.port) return 'port_not_allowed';
  // `new URL` has already normalised numeric, octal and hex spellings (0x7f000001, 0177.0.0.1,
  // 2130706433, 127.1 all become 127.0.0.1), so a plain dotted-quad test catches every IPv4 trick.
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host.includes(':') || /^\d+(\.\d+){0,3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host))
    return 'ip_literal_not_allowed';
  if (!host.includes('.')) return 'public_hostname_required';
  if (/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host.toLowerCase()))
    return 'internal_hostname_not_allowed';
  // The platform's own zones (api.ebda.app, every storefront): a webhook must not loop back into us.
  if (isBrandHost(host)) return 'platform_host_not_allowed';
  return null;
}

const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((v, ctx) => {
    const err = webhookUrlShapeError(v);
    if (err) ctx.addIssue({ code: 'custom', message: err });
  });

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1)
  .max(WEBHOOK_EVENT_TYPES.length)
  .transform(a => [...new Set(a)]);

export const webhookEndpointCreateSchema = z
  .object({
    url: urlSchema,
    description: z.string().trim().max(120).nullable().optional(),
    events: eventsSchema,
    includeCustomer: z.boolean().default(false),
  })
  .strict();
export type WebhookEndpointCreateInput = z.infer<typeof webhookEndpointCreateSchema>;

export const webhookEndpointUpdateSchema = z
  .object({
    url: urlSchema.optional(),
    description: z.string().trim().max(120).nullable().optional(),
    events: eventsSchema.optional(),
    includeCustomer: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine(v => Object.keys(v).length > 0, { message: 'empty_update' });
export type WebhookEndpointUpdateInput = z.infer<typeof webhookEndpointUpdateSchema>;

/** What a receiver gets, as a type for the docs and tests. */
export interface WebhookEnvelope<T = unknown> {
  id: string;
  type: WebhookEventType | typeof WEBHOOK_TEST_EVENT;
  apiVersion: string;
  createdAt: string;
  storeId: string;
  livemode: boolean;
  data: T;
}
