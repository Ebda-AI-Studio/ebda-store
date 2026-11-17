const CONSENT_COOKIE_NAME = 'force-cookie-consent';

/**
 * Client-side parse of the `force-cookie-consent` cookie. Mirrors
 * `ConsentContext.tsx`'s own `readCookieClient` — kept as a standalone,
 * dependency-free function (rather than importing from the context module)
 * so it can be used by components that mount before `ConsentProvider` has
 * synced, e.g. the tenant-cacheable routing tree's
 * `ConsentGatedMarketingPixels` (see
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6).
 */
export function readMarketingConsentFromCookie(): boolean {
  if (typeof document === 'undefined') return false;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CONSENT_COOKIE_NAME}=([^;]*)`));
  if (!match) return false;
  try {
    const parsed = JSON.parse(decodeURIComponent(match[1])) as {
      marketing?: boolean;
      v?: number;
    };
    return !!parsed && parsed.v === 1 && parsed.marketing === true;
  } catch {
    return false;
  }
}
