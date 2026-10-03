/**
 * Dynamic per-store `/favicon.ico` for CUSTOM-DOMAIN storefronts.
 *
 * `/favicon.ico` is normally a static file (`apps/web/public/favicon.ico`,
 * a neutral non-branded icon) and — until 2026-07-02 — completely bypassed
 * per-store resolution, because the middleware matcher excluded it. So a
 * merchant who uploaded their own favicon never saw it as the browser-tab /
 * link-preview icon for scrapers hitting `/favicon.ico` directly.
 *
 * `middleware.ts` now rewrites `/favicon.ico` → here, but ONLY for requests
 * whose host resolves to a custom domain (`storeIdentifier` truthy —
 * platform hosts like `ebda.app` never enter that branch, so they
 * are completely unaffected by this route and keep serving the static file).
 *
 * We redirect rather than proxy bytes: simplest, avoids re-fetching /
 * re-encoding the icon on every request, and lets the browser cache the
 * final asset at its real CDN URL.
 */
import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store-resolver';

// Store resolution depends on per-request headers (x-store-domain) — this
// route must always run per-request, never be statically cached by Next.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const store = await getStore();

  // Mirrors the <link rel="icon"> fallback in app/layout.tsx's
  // generateMetadata(): merchant's favicon, else the store's own logo, so a
  // branded store never shows the platform's neutral icon once it has ANY
  // uploaded artwork. Both are validated absolute URLs (Zod `.url()` on the
  // API side, uploaded to the R2 asset CDN), safe to redirect to directly.
  const faviconSrc = store.favicon || store.logo || undefined;

  if (faviconSrc) {
    const response = NextResponse.redirect(faviconSrc, 302);
    response.headers.set('Cache-Control', 'public, max-age=3600');
    return response;
  }

  // No merchant favicon/logo — fall back to the neutral platform default.
  // Redirect to the SAME-ORIGIN static file with a `sf=1` marker so
  // middleware's favicon.ico rewrite does not re-intercept this request
  // (that would loop straight back to this route handler).
  const fallbackUrl = new URL('/favicon.ico?sf=1', request.url);
  const response = NextResponse.redirect(fallbackUrl, 302);
  response.headers.set('Cache-Control', 'public, max-age=3600');
  return response;
}
