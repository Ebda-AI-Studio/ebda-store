'use client';

import { useEffect, useState, type ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import { scrubPostHogCapture } from '@ebda/shared';
import { EBDA_CONSENT_EVENT, analyticsConsentedFromCookies } from '@ebda/shared/tracking';

// posthog-js is lazy-loaded (kept out of the first-load bundle); this holds the
// instance once loaded so captureEvent() can use it (no-op until then).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let posthogInstance: any = null;

/**
 * PostHog product analytics — admin side.
 *
 * CONSENT-GATED (Ruling ICEBERG-ADM-CONSENT-1, Iceberg audit #5, 2026-11-10): it used to be always-on, which loaded a
 * third-party analytics script and set its cookie for merchants who had never said yes. It now follows the SAME first-party
 * `ebda_consent` cookie the marketing site and the signup funnel write (shared across *.ebda.app): posthog-js is not even
 * imported until that cookie says `analytics: true`; a later "decline" (EBDA_CONSENT_EVENT from the banner) opts capture out.
 *
 * Captures: pageviews on route change, click events, form submits.
 * Plus you can `captureEvent('bulk_ai_sweep_started', {...})` at
 * key flow points for funnel analysis.
 *
 * No-op when NEXT_PUBLIC_POSTHOG_KEY is missing.
 */

interface Props {
  children: ReactNode;
}

/** True only when the visitor's `ebda_consent` cookie allows analytics. No cookie, a bad cookie or "decline" = false. */
export function adminAnalyticsConsented(doc: Document): boolean {
  return analyticsConsentedFromCookies(doc.cookie);
}

export function PostHogProvider({ children }: Props) {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const apiHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';
  const [consented, setConsented] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => {
      const ok = adminAnalyticsConsented(document);
      setConsented(ok);
      if (!ok && posthogInstance?.__loaded) posthogInstance.opt_out_capturing?.();
      if (ok && posthogInstance?.__loaded) posthogInstance.opt_in_capturing?.();
    };
    sync();
    window.addEventListener(EBDA_CONSENT_EVENT, sync);
    return () => window.removeEventListener(EBDA_CONSENT_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!apiKey || !consented) return;
    if (typeof window === 'undefined') return;
    let cancelled = false;
    // Lazy-load posthog-js so the (heavy) analytics lib is NOT in the admin's
    // first-load bundle — it's only fetched after auth when this effect runs.
    // children always render, so deferring the import never blanks the app.
    void import('posthog-js').then(({ default: posthog }) => {
      if (cancelled) return;
      posthogInstance = posthog;
      if (posthog.__loaded) return;
      posthog.init(apiKey, {
        api_host: apiHost,
        ip: false,
        capture_pageview: 'history_change',
        disable_session_recording: true,
        respect_dnt: true,
        persistence: 'localStorage+cookie',
        // Error Tracking autocapture: emit a $exception event for every
        // unhandled JS error + promise rejection. Was off — operator-side
        // client errors were invisible in PostHog (0 $exception events ever).
        capture_exceptions: true,
        // Free-text query values (?q=, ?search=, ?email=, ?phone=) never leave in a capture:
        // the storefront search page is /search?q=<term> (@ebda/shared sentry-url-scrub).
        before_send: scrubPostHogCapture,
      });
      // Session-replay is off, so link PostHog ↔ Sentry by distinct_id: a Sentry
      // error carries the id to look up that operator's PostHog events without
      // recording their screen. Best-effort.
      try {
        const distinctId = posthog.get_distinct_id?.();
        if (distinctId) {
          Sentry.setTag('posthog_distinct_id', distinctId);
          Sentry.setContext('posthog', {
            distinct_id: distinctId,
            session_id: posthog.get_session_id?.(),
          });
        }
      } catch {
        // Sentry not initialised (DSN unset) — ignore.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey, apiHost, consented]);

  return <>{children}</>;
}

export function captureEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (!adminAnalyticsConsented(document)) return;
  if (!posthogInstance || !posthogInstance.__loaded) return;
  posthogInstance.capture(eventName, properties);
}
