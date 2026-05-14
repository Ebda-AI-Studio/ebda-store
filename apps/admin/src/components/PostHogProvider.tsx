'use client';

import { useEffect, type ReactNode } from 'react';
import posthog from 'posthog-js';

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
    if (posthog.__loaded) return;

    posthog.init(apiKey, {
      api_host: apiHost,
      ip: false,
      capture_pageview: 'history_change',
      disable_session_recording: true,
      respect_dnt: true,
      persistence: 'localStorage+cookie',
    });
  }, [apiKey, apiHost]);

  return <>{children}</>;
}

export function captureEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (!posthog.__loaded) return;
  posthog.capture(eventName, properties);
}
