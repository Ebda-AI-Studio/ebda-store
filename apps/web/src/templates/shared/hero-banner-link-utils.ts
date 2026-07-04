import { isSafeUrl, sanitizeUrl } from '@force/shared';

/**
 * Resolve a banner `link` (`HeroSlide.link` / `HeroBannerProps.link`) to a
 * safe, renderable href, or `null` when the link is empty/unset/unsafe.
 *
 * Extracted into its own plain `.ts` module (no JSX) so it's importable from
 * a vitest unit test without pulling in `HeroBannerLink.tsx` — `apps/web`'s
 * `tsconfig.json` sets `jsx: "preserve"` (required for Next's own compiler),
 * which esbuild/vite cannot transform on its own, so importing any `.tsx`
 * file under `apps/web` from this repo's vitest config fails at the
 * transform step. See `tests/unit/hero-banner-link.test.ts`.
 *
 * Reuses the SAME `isSafeUrl`/`sanitizeUrl` helpers the storefront already
 * uses for `ctaHref` — defense-in-depth on top of the server-side
 * `heroSlideSchema` refine (a `javascript:`/`data:` value can't be saved,
 * but this neutralizes any pre-existing/legacy row too).
 */
export function resolveBannerLink(link: string | undefined): string | null {
  if (!link || !isSafeUrl(link)) return null;
  return sanitizeUrl(link);
}
