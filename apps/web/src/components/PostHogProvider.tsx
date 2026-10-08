'use client';

import { useEffect, type ReactNode } from 'react';
import type { PostHog } from 'posthog-js';
import { useConsent } from '../contexts/ConsentContext';
import { loadSentry } from '../lib/sentry-lazy';

/**
 * PostHog product analytics — storefront side.
 *
 * Gated on the marketing consent cookie because PostHog captures
 * page views + click data + visitor identifiers, which falls under
 * the GDPR / applicable GCC data-protection law (see
 * docs/legal/gcc-data-protection.md) "analytics cookies" category and
 * requires opt-in. Same gate as the Meta / GA / TikTok pixels.
 *
 * Init flow:
 *   1. Visitor lands → consent banner shows (no PostHog loaded).
 *   2. Visitor clicks "Accept all" or "Customize → marketing on".
 *   3. setConsent({marketing:true}) writes the cookie + reloads.
 *   4. After reload, this provider sees consent.marketing === true
 *      and calls posthog.init() ONCE for the session.
 *   5. Subsequent route changes auto-capture via posthog's
 *      browser-router hook.
 *
 * No-op when NEXT_PUBLIC_POSTHOG_KEY is missing (dev / preview /
 * pre-account-creation).
 *
 * Performance (docs/RULINGS.md PERF-STORE-2): `posthog-js` is ~95 KB gzip and
 * only a consenting visitor ever runs it, so it is `import()`ed from the
 * consent effect instead of statically — every other visitor (and every
 * Lighthouse run) never downloads it. `captureEvent` is a no-op until the
 * module has loaded, exactly as it was a no-op until `posthog.__loaded`.
 */

let posthogClient: PostHog | null = null;

interface Props {
  children: ReactNode;
}

export function PostHogProvider({ children }: Props) {
  const { consent } = useConsent();
  const marketingConsentGranted = consent?.marketing === true;
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const apiHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';

  useEffect(() => {
    if (!apiKey || !marketingConsentGranted) return;
    // posthog-js is safe to init multiple times — internal guard,
    // but we still skip the call when already initialised to avoid
    // a console warning on hot reload.
    if (typeof window === 'undefined') return;
    if (posthogClient?.__loaded) return;

    let cancelled = false;
    void import('posthog-js').then(({ default: posthog }) => {
      if (cancelled || posthog.__loaded) return;
      posthogClient = posthog;
      posthog.init(apiKey, {
        api_host: apiHost,
        // Don't capture IP — the EU/GCC PoV: IPs are PII under GDPR
        // and applicable GCC data-protection law (see
        // docs/legal/gcc-data-protection.md). Visitor identity comes from PostHog's
        // distinct_id cookie (anonymous by default until we call
        // posthog.identify(userId) at login).
        ip: false,
        // Capture pageviews automatically on route change (Next.js
        // App Router doesn't fire window.history events the same way
        // SPAs do; posthog has a config flag for this).
        capture_pageview: 'history_change',
        // Session recording off by default — we only want behavioural
        // analytics, not session replay (which has bigger consent
        // implications).
        disable_session_recording: true,
        // Error Tracking autocapture: emit a $exception event for every
        // unhandled JS error + promise rejection. Was off — client-side
        // errors were invisible in PostHog (0 $exception events ever).
        capture_exceptions: true,
        // Respect Do Not Track + Global Privacy Control.
        respect_dnt: true,
        // Persistence type: cookie + localStorage. Cookie alone won't
        // survive Safari ITP 7-day cap; localStorage backs it up.
        persistence: 'localStorage+cookie',
      });
      // Session-replay is deliberately off (see above), so link PostHog ↔ Sentry
      // by distinct_id: a Sentry error then carries the id to look up that
      // visitor's PostHog event stream, without recording their screen.
      try {
        const distinctId = posthog.get_distinct_id?.();
        if (distinctId) {
          const sessionId = posthog.get_session_id?.();
          void loadSentry().then(Sentry => {
            Sentry?.setTag('posthog_distinct_id', distinctId);
            Sentry?.setContext('posthog', { distinct_id: distinctId, session_id: sessionId });
          });
        }
      } catch {
        // Sentry not initialised (DSN unset) — ignore.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey, apiHost, marketingConsentGranted]);

  return <>{children}</>;
}

/**
 * Helper for component-level event capture. No-op when posthog
 * isn't loaded (consent not granted, key not configured).
 */
export function captureEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (!posthogClient?.__loaded) return;
  posthogClient.capture(eventName, properties);
}
