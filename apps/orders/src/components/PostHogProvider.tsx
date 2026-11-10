'use client';

import { useEffect, useState, type ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import { scrubPostHogCapture } from '@ebda/shared';
import { EBDA_CONSENT_EVENT, analyticsConsentedFromCookies } from '@ebda/shared/tracking';

/**
 * PostHog product analytics — Orders PWA (fulfilment staff tooling).
 *
 * Builder Reality Audit 2026-07-09 (Lens C, High): the Orders PWA — the surface
 * store staff use to run live fulfilment — shipped with ZERO client analytics.
 * Sentry (errors) was added 2026-07-02; this adds behavioural analytics so an
 * operator's confusing/broken UX moment (not just an outright crash) is visible.
 *
 * CONSENT-GATED like the admin (Ruling ICEBERG-ADM-CONSENT-1, 2026-11-10): posthog-js is not imported until the shared
 * first-party `ebda_consent` cookie (*.ebda.app) says `analytics: true`; a later decline opts capture out. Session recording
 * stays OFF (behavioural analytics only; the deliberate no-replay posture, 2026-07-09).
 *
 * The heavy `posthog-js` lib is dynamically imported so it stays out of the
 * first-load (login) bundle. No-op when NEXT_PUBLIC_POSTHOG_KEY is missing
 * (dev / preview), so unconfigured builds run cleanly.
 */

interface Props {
  children: ReactNode;
}

let posthogInstance: typeof import('posthog-js').default | null = null;

export function PostHogProvider({ children }: Props) {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const apiHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';
  const [consented, setConsented] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => {
      const ok = analyticsConsentedFromCookies(document.cookie);
      setConsented(ok);
      if (posthogInstance?.__loaded) {
        if (ok) posthogInstance.opt_in_capturing();
        else posthogInstance.opt_out_capturing();
      }
    };
    sync();
    window.addEventListener(EBDA_CONSENT_EVENT, sync);
    return () => window.removeEventListener(EBDA_CONSENT_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!apiKey || !consented) return;
    if (typeof window === 'undefined') return;

    let cancelled = false;
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
        // unhandled JS error + promise rejection. Was off — fulfilment-staff
        // client errors were invisible in PostHog (0 $exception events ever).
        capture_exceptions: true,
        // Free-text query values (?q=, ?search=, ?email=, ?phone=) never leave in a capture:
        // the storefront search page is /search?q=<term> (@ebda/shared sentry-url-scrub).
        before_send: scrubPostHogCapture,
      });
      // Session-replay is off, so link PostHog ↔ Sentry by distinct_id instead:
      // any Sentry error then carries the id needed to look up that operator's
      // event stream in PostHog (no screen recording required).
      linkPostHogToSentry(posthog);
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey, apiHost, consented]);

  return <>{children}</>;
}

export function captureEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (!analyticsConsentedFromCookies(document.cookie)) return;
  if (!posthogInstance?.__loaded) return;
  posthogInstance.capture(eventName, properties);
}

/**
 * Tag Sentry with the PostHog distinct_id (+ session id) so an error and the
 * behavioural context that led to it can be cross-referenced without session
 * replay. Best-effort — never throws into the render path.
 */
function linkPostHogToSentry(posthog: typeof import('posthog-js').default): void {
  try {
    const distinctId = posthog.get_distinct_id?.();
    if (!distinctId) return;
    Sentry.setTag('posthog_distinct_id', distinctId);
    Sentry.setContext('posthog', {
      distinct_id: distinctId,
      session_id: posthog.get_session_id?.(),
    });
  } catch {
    // Sentry not initialised (DSN unset) or PostHog api shape changed — ignore.
  }
}
