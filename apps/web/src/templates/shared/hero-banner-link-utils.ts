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
 *
 * `urlPrefix` (from `useStoreUrl('')`) is prepended to ROOT-RELATIVE links
 * only (`/...`) so the link keeps store context on a platform host
 * (`<slug>.ebda.app/...`). Fragment/query/dot-relative links (`#`,
 * `?`, `./`, `../`) and absolute/external links (`http`, `mailto:`, `tel:`)
 * are left untouched.
 */
export function resolveBannerLink(link: string | undefined, urlPrefix?: string): string | null {
  if (!link || !isSafeUrl(link)) return null;
  const safe = sanitizeUrl(link);
  if (urlPrefix && safe.startsWith('/')) {
    return `${urlPrefix}${safe}`;
  }
  return safe;
}
