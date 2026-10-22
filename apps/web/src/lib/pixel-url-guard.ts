import { urlCarriesSensitiveQuery } from '@ebda/shared';

/**
 * Whether a page URL is unfit to hand to an ad pixel (Ruling PIXEL-CONSENT-1, launch blocker 32).
 * Every pixel library reads the page URL itself on init and on PageView and sends it to its
 * network, so a URL carrying a typed term, an email or a phone, or a one-time credential
 * (password reset, email verification, cart restore, WhatsApp cart token), must never be on a
 * page where a pixel is loaded. The key list is `SENSITIVE_QUERY_PARAMS`, the same one Sentry,
 * PostHog and the API's log lines scrub, so the three cannot drift.
 */
export const urlCarriesPixelBlockedQuery = urlCarriesSensitiveQuery;
