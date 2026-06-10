'use client';

import { useEffect, type ReactNode } from 'react';

// posthog-js is lazy-loaded (kept out of the first-load bundle); this holds the
// instance once loaded so captureEvent() can use it (no-op until then).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let posthogInstance: any = null;

/**
 * PostHog product analytics — admin side.
 *
 * Always-on (no consent gating). The admin is an operator-only
 * surface — no public visitors, no GDPR consent surface for ops
 * data. Operators are platform staff + merchants managing their
 * own stores; their usage is internal product telemetry, not
 * third-party tracking.
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

export function PostHogProvider({ children }: Props) {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const apiHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';

  useEffect(() => {
    if (!apiKey) return;
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
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiKey, apiHost]);

  return <>{children}</>;
}

export function captureEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (!posthogInstance || !posthogInstance.__loaded) return;
  posthogInstance.capture(eventName, properties);
}
