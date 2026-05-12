// Sender resolution for branded transactional email.
// See docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md
//
// Why a standalone module: this is a pure function (no I/O, no DB) so it
// gets the cheapest possible unit tests — feed it a plain object, assert
// the from-line. The full ResendService composes this helper.

export const PLATFORM_EMAIL_DOMAIN = 'forcemediakw.com';

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

export function resolveSender(store: StoreSenderShape): ResolvedSender {
  const displayName = store.name;
  const localPart =
    store.emailSenderLocalPart && store.emailSenderLocalPart.trim().length > 0
      ? store.emailSenderLocalPart.trim()
      : 'noreply';

  const useCustomDomain =
    store.emailDomainStatus === 'verified' && !!store.domain && store.domain.length > 0;

  const host = useCustomDomain ? (store.domain as string) : PLATFORM_EMAIL_DOMAIN;

  return {
    from: `${displayName} <${localPart}@${host}>`,
    replyTo: store.email ? store.email : undefined,
  };
}
