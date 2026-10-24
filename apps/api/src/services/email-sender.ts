// Sender resolution for branded transactional email.
// See docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md
//
// Why a standalone module: this is a pure function (no I/O, no DB) so it
// gets the cheapest possible unit tests — feed it a plain object, assert
// the from-line. The full ResendService composes this helper.
import { z } from 'zod';
import { BRAND } from '@ebda/shared';
import { customSenderDomainsSupported } from './mail-transport';

const PLATFORM_EMAIL_DOMAIN: string = BRAND.domains.marketing;

export interface StoreSenderShape {
  name: string;
  /** Required on the platform domain (the mandatory suffix of the sender address). */
  slug?: string | null;
  domain?: string | null;
  email?: string | null;
  emailSenderLocalPart?: string | null;
  emailDomainStatus?: string | null;
}

export interface ResolvedSender {
  from: string;
  replyTo?: string;
}

// Strip CRLF + control chars from a display name to defend against
// header injection. Resend's SDK should also reject malformed headers
// but defence in depth is the rule here. Quoting display names that
// contain RFC 5322 specials (commas, angle brackets) is deferred to
// the SDK; we only sanitize control-chars + trim.
function sanitizeDisplayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  // Also drop `"`, `<`, `>` and `\`: they break the `Name <addr>` form, and a rejected From is a
  // permanent failure for every message of the store (Cloudflare E_VALIDATION_ERROR).
  return name
    .replace(/[\r\n\x00-\x1f\x7f"<>\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Merchant mail on the platform domain comes from `<prefix>.<storeSlug>@ebda.app`. The prefix is
 * one of these (an ALLOWLIST: a denylist loses to `no.reply`, `ebda-support`, `billing2`), and the
 * store-unique slug suffix is mandatory, so a merchant address can never equal a platform
 * mailbox. Only the platform itself sends from the bare `no-reply@` / `ahlan@` (brandFrom()).
 */
export const MERCHANT_SENDER_PREFIXES = ['orders', 'receipts', 'hello', 'info', 'support'] as const;
export type MerchantSenderPrefix = (typeof MERCHANT_SENDER_PREFIXES)[number];
const DEFAULT_MERCHANT_PREFIX: MerchantSenderPrefix = 'orders';

export function isMerchantSenderPrefix(v: unknown): v is MerchantSenderPrefix {
  return typeof v === 'string' && (MERCHANT_SENDER_PREFIXES as readonly string[]).includes(v);
}

/**
 * Save-time validation of a store's sender prefix (store.routes.ts). Allowlist only; the legacy
 * default `noreply` the admin used to save (and empty/null) is accepted as "unset".
 */
export const merchantSenderPrefixInput = z.preprocess(
  v => (v === '' || v === null || v === 'noreply' || v === 'no-reply' ? undefined : v),
  z.enum(MERCHANT_SENDER_PREFIXES).optional()
);

/** `<prefix>.<slug>`; a prefix outside the allowlist (legacy `noreply`, anything typed) becomes `orders`. */
export function merchantSenderLocalPart(
  chosen: string | null | undefined,
  slug: string | null | undefined
): string {
  const prefix = isMerchantSenderPrefix(chosen?.trim()) ? chosen!.trim() : DEFAULT_MERCHANT_PREFIX;
  const slugPart = (slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // Fail fast: a caller that forgot to select `slug` must not silently send from a bare mailbox.
  if (!slugPart) throw new Error('store slug is required to build the sender address');
  return `${prefix}.${slugPart}`;
}

export function resolveSender(store: StoreSenderShape): ResolvedSender {
  const displayName = sanitizeDisplayName(store.name);
  const useCustomDomain =
    customSenderDomainsSupported() &&
    store.emailDomainStatus === 'verified' &&
    !!store.domain &&
    store.domain.length > 0;

  // A verified merchant domain (legacy provider only) keeps the merchant's own prefix; the
  // platform domain gets the allowlisted `<prefix>.<slug>` form.
  const localPart = useCustomDomain
    ? store.emailSenderLocalPart?.trim() || 'noreply'
    : merchantSenderLocalPart(store.emailSenderLocalPart, store.slug);

  const host = useCustomDomain ? (store.domain as string) : PLATFORM_EMAIL_DOMAIN;

  return {
    from: `${displayName} <${localPart}@${host}>`,
    replyTo: store.email ? store.email : undefined,
  };
}
