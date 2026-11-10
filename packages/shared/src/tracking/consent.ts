/**
 * Ebda's own acquisition-tracking consent (the platform funnel, not merchant storefronts).
 *
 * One first-party cookie on the registrable domain (`.ebda.app`) so a choice made on the
 * marketing site also covers store.ebda.app (signup / onboarding). Nothing tracks until a
 * visitor has said yes; "no decision yet" is treated exactly like "no".
 */

export const EBDA_CONSENT_COOKIE = 'ebda_consent';
export const EBDA_CONSENT_MAX_AGE_DAYS = 180;
/** Window event fired after the banner writes a new answer, so an already-mounted surface (the admin PostHog) can follow it. */
export const EBDA_CONSENT_EVENT = 'ebda:consent-change';

export interface EbdaConsent {
  v: 1;
  /** PostHog funnel analytics. */
  analytics: boolean;
  /** Meta Pixel + Conversions API attribution. */
  marketing: boolean;
}

export function serializeConsent(c: Pick<EbdaConsent, 'analytics' | 'marketing'>): string {
  const value: EbdaConsent = { v: 1, analytics: c.analytics, marketing: c.marketing };
  return encodeURIComponent(JSON.stringify(value));
}

/** Parse the cookie value. Anything malformed, or from another version, is "no decision". */
export function parseConsent(raw: string | null | undefined): EbdaConsent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<EbdaConsent> | null;
    if (!parsed || parsed.v !== 1) return null;
    if (typeof parsed.analytics !== 'boolean' || typeof parsed.marketing !== 'boolean') return null;
    return { v: 1, analytics: parsed.analytics, marketing: parsed.marketing };
  } catch {
    return null;
  }
}

/** True when the visitor allowed anything at all (what the signup payload gates on). */
export function hasAnyConsent(c: EbdaConsent | null): boolean {
  return !!c && (c.analytics || c.marketing);
}

/** Analytics allowed by a `document.cookie` string? No cookie, a malformed one or "decline" = false (admin + orders PostHog gate). */
export function analyticsConsentedFromCookies(cookieString: string): boolean {
  const m = cookieString.match(new RegExp(`(?:^|; )${EBDA_CONSENT_COOKIE}=([^;]*)`));
  return parseConsent(m ? m[1] : null)?.analytics === true;
}
