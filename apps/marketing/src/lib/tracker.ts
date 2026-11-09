import { createTracker, type Tracker } from '@ebda/shared/tracking-browser';
import { pagePath } from './site';

let instance: Tracker | null = null;

/**
 * The marketing site's tracker (client only). Provider ids are public build-time env:
 *   NEXT_PUBLIC_EBDA_META_PIXEL_ID   unset -> no Meta script, no errors
 *   NEXT_PUBLIC_POSTHOG_KEY / _HOST  unset -> no PostHog script, no errors
 * Nothing loads before the visitor accepts the cookie banner.
 */
export function getTracker(): Tracker | null {
  if (typeof window === 'undefined') return null;
  if (!instance) {
    const lang = document.documentElement.lang === 'en' ? 'en' : 'ar';
    instance = createTracker(
      {
        metaPixelId: process.env.NEXT_PUBLIC_EBDA_META_PIXEL_ID,
        posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY,
        posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
        privacyUrl: `${pagePath(lang, 'privacy')}/`,
      },
      window
    );
  }
  return instance;
}
