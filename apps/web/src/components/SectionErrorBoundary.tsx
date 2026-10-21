'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';

interface SectionErrorBoundaryProps {
  children: ReactNode;
  /** Short identifier included in the Sentry tag for triage (e.g.
   *  'reviews', 'best-sellers', 'extra:abc123'). */
  section: string;
}

interface SectionErrorBoundaryState {
  hasError: boolean;
}

/**
 * Section-level error isolation (Lens M graceful degradation). Wraps an
 * independent, non-critical storefront section (homepage carousel, PDP
 * review/FBT/YMAL block) so a render-time exception in ONE section
 * degrades only that section — the rest of the page stays usable instead
 * of the whole route falling through to the route-level error.tsx.
 *
 * Hand-rolled class component: React error boundaries have no hook
 * equivalent (getDerivedStateFromError / componentDidCatch are
 * class-only APIs). Reports to Sentry when configured (safe no-op when
 * NEXT_PUBLIC_SENTRY_DSN_WEB is unset — see instrumentation-client.ts).
 *
 * Do NOT wrap core/critical page elements this way (PDP gallery/price/
 * add-to-cart, homepage hero) — those should keep bubbling to the route's
 * error.tsx rather than silently disappear behind a small inline fallback.
 */
export class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  SectionErrorBoundaryState
> {
  state: SectionErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SectionErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    Sentry.captureException(error, {
      tags: { section: this.props.section },
      extra: { componentStack: errorInfo.componentStack },
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      // Class component — no useLanguage() hook available. Mirrors the
      // documentElement.lang fallback the root app/error.tsx already uses
      // for the same reason.
      const isAr = typeof document !== 'undefined' && document.documentElement.lang === 'ar';
      return (
        <div
          role="alert"
          className="my-6 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground"
        >
          {isAr ? 'معرفناش نحمّل القسم ده.' : "This section couldn't load."}
        </div>
      );
    }
    return this.props.children;
  }
}
