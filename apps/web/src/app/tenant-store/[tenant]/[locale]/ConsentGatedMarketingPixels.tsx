'use client';

import { useEffect, useState } from 'react';
import type { MarketingPixels } from '@ebda/shared';
import { MarketingPixelsProvider } from '@/components/MarketingPixels';
import { readMarketingConsentFromCookie } from '@/lib/consent-cookie';

/**
 * Track-A (tenant-cacheable) consent gate — Phase 1 of
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md, dormant while
 * `STOREFRONT_TENANT_ROUTING` is off (this whole route tree is unreachable
 * until the flag flips — see `middleware.ts`).
 *
 * Consent option (a) from plan §3.6: the cached HTML for this layout can't
 * read the `force-cookie-consent` cookie server-side without re-forcing
 * dynamic rendering (`cookies()` is a Next Dynamic API) — that would defeat
 * the entire point of this route tree. So the HTML never contains the
 * pixel `<script>` tags at all: the initial state is unconditionally
 * `false` (identical on the server and the client's first hydration pass —
 * no hydration mismatch), and a `useEffect` re-syncs from `document.cookie`
 * immediately after mount, exactly mirroring `ConsentContext.tsx`'s own
 * "re-sync from cookie on mount, for the ISR-cached-page case" pattern.
 * Non-consenting visitors never see any pixel-related markup. Previously-
 * consenting repeat visitors get pixels one paint after mount instead of
 * in the initial SSR HTML — a bounded, accepted trade-off (plan §3.6).
 *
 * KNOWN Phase-1 interaction (documented in the PR, not a Phase-1 blocker):
 * this tree is currently still wrapped by the legacy, unchanged
 * `app/layout.tsx`, which does its OWN SSR consent-gated
 * `<MarketingPixelsProvider>` render. Until the follow-up root-layout
 * decomposition (moving the legacy provider stack into a route-group-only
 * layout, deferred out of this PR — see PR body) lands, a Track-A page
 * reached with the flag on would render pixels from BOTH layouts when
 * consent is granted (a double-fire bug, not a leak). Phase 2 caught it, so
 * this component is currently NOT reached: the tenant-store layout returns
 * early while `ROOT_LAYOUT_OWNS_STORE_CHROME` is true (the root layout is the
 * single pixel writer until the decomposition lands) — see `./layout.tsx` and
 * tests/unit/web-tenant-tree-single-pixel-writer.test.ts.
 */
export function ConsentGatedMarketingPixels({ pixels }: { pixels?: Record<string, unknown> }) {
  const [hasMarketingConsent, setHasMarketingConsent] = useState(false);

  useEffect(() => {
    if (readMarketingConsentFromCookie()) setHasMarketingConsent(true);
  }, []);

  if (!hasMarketingConsent || !pixels || Object.keys(pixels).length === 0) {
    return null;
  }

  return <MarketingPixelsProvider pixels={pixels as MarketingPixels} />;
}
