// Sender resolution for branded transactional email.
// See docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md
//
// Why a standalone module: this is a pure function (no I/O, no DB) so it
// gets the cheapest possible unit tests — feed it a plain object, assert
// the from-line. The full ResendService composes this helper.
import { BRAND } from '@force/shared';

const PLATFORM_EMAIL_DOMAIN: string = BRAND.domains.marketing;

export interface StoreSenderShape {
  name: string;
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
  return name.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim();
}

export function resolveSender(store: StoreSenderShape): ResolvedSender {
  const displayName = sanitizeDisplayName(store.name);
  const useCustomDomain =
    store.emailDomainStatus === 'verified' && !!store.domain && store.domain.length > 0;

  // Merchant domains keep the conventional `noreply`; the platform domain
  // uses the brand's own no-reply mailbox (no-reply@ebda.app).
  const defaultLocalPart = useCustomDomain ? 'noreply' : BRAND.noReplyEmail.split('@')[0];
  const localPart =
    store.emailSenderLocalPart && store.emailSenderLocalPart.trim().length > 0
      ? store.emailSenderLocalPart.trim()
      : defaultLocalPart;

  const host = useCustomDomain ? (store.domain as string) : PLATFORM_EMAIL_DOMAIN;

  return {
    from: `${displayName} <${localPart}@${host}>`,
    replyTo: store.email ? store.email : undefined,
  };
}
