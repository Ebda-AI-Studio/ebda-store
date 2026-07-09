'use client';

import { useEffect, type ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * PostHog product analytics — Orders PWA (fulfilment staff tooling).
 *
 * Builder Reality Audit 2026-07-09 (Lens C, High): the Orders PWA — the surface
 * store staff use to run live fulfilment — shipped with ZERO client analytics.
 * Sentry (errors) was added 2026-07-02; this adds behavioural analytics so an
 * operator's confusing/broken UX moment (not just an outright crash) is visible.
 *
 * Orders is operator-only (store staff, no public visitors), so — mirroring the
 * admin dashboard — PostHog is NOT consent-gated (internal-tool telemetry, not
 * customer data) and session recording stays OFF (behavioural analytics only,
 * matching web/admin; the deliberate no-replay posture, 2026-07-09).
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

  useEffect(() => {
    if (!apiKey) return;
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
      });
      // Session-replay is off, so link PostHog ↔ Sentry by distinct_id instead:
      // any Sentry error then carries the id needed to look up that operator's
      // event stream in PostHog (no screen recording required).
      linkPostHogToSentry(posthog);
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey, apiHost]);

  return <>{children}</>;
}

export function captureEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
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
