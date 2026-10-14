import { BRAND_MARKETING_URL } from '@force/shared';
import { createTracker, type Tracker } from '@force/shared/tracking-browser';

let instance: Tracker | null = null;

/**
 * Ebda's own acquisition tracker on the public funnel pages (signup, verify-email, onboarding).
 * Distinct from the merchants' storefront pixels. Public build-time env, all optional:
 *   NEXT_PUBLIC_EBDA_META_PIXEL_ID  unset -> no Meta script
 *   NEXT_PUBLIC_POSTHOG_KEY / _HOST unset -> no PostHog script
 * Nothing loads before consent; the consent cookie is shared with ebda.app.
 */
export function getEbdaTracker(): Tracker | null {
  if (typeof window === 'undefined') return null;
  if (!instance) {
    const en = document.documentElement.lang === 'en';
    instance = createTracker(
      {
        metaPixelId: process.env.NEXT_PUBLIC_EBDA_META_PIXEL_ID,
        posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY,
        posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
        privacyUrl: `${BRAND_MARKETING_URL}${en ? '/en' : ''}/privacy/`,
      },
      window
    );
  }
  return instance;
}

/** Only the pre-account funnel is tracked; the logged-in dashboard never is. */
export const EBDA_FUNNEL_PATHS = ['/signup', '/verify-email', '/onboarding'] as const;

export function isFunnelPath(pathname: string | null): boolean {
  return !!pathname && EBDA_FUNNEL_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));
}
