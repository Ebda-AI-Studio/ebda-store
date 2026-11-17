'use client';

import type { ReactNode } from 'react';
import Link from '../../components/StoreLink';
import { resolveBannerLink } from './hero-banner-link-utils';

export interface HeroBannerLinkProps {
  /** The slide's optional banner link (`HeroSlide.link` / `HeroBannerProps.link`). */
  link?: string;
  /** Accessible label for the stretched anchor — slide headline or alt text. */
  label?: string;
  /** See HeroBannerProps.urlPrefix — prefixed onto relative `link` values. */
  urlPrefix?: string;
  children: ReactNode;
}

// Re-exported for backwards-compat with call sites that imported the
// resolver from this module; the canonical home + unit tests are now
// `hero-banner-link-utils.ts` (a plain `.ts` module, importable from vitest
// without pulling in this file's JSX — see `tests/unit/hero-banner-link.test.ts`).
export { resolveBannerLink };

/**
 * Stretched-link wrapper implementing the "banner link" feature
 * (docs/plans/done/2026-07-04-hero-banner-link.md): when a hero slide has an
 * optional `link` set, the whole slide becomes a clickable marketing
 * banner. The slide's own CTA button keeps its own destination and wins
 * the click because it renders with `relative z-10` (see the CTA `<Link>`
 * in `HeroBanner.tsx` — the sole render site for `HeroSlide`-driven
 * content, used directly for single-banner mode and internally by
 * `HeroSlider` for carousel mode), stacking above this wrapper's
 * `absolute inset-0 z-0` anchor.
 *
 * Empty/unset/unsafe link → renders `children` inside a Fragment with NO
 * wrapper element and NO DOM change — this is the default for every
 * existing store today (the field is new + optional), matching the
 * "New visual features default OFF" rule.
 *
 * The parent slide container MUST already be `position: relative` (every
 * consumer's container class includes `relative`) for `absolute inset-0`
 * to cover exactly the slide.
 */
export function HeroBannerLink({ link, label, urlPrefix, children }: HeroBannerLinkProps) {
  const safeLink = resolveBannerLink(link, urlPrefix);

  if (!safeLink) {
    return <>{children}</>;
  }

  // External http(s) links get rel="noopener" (defense against
  // window.opener tab-napping); same-tab navigation is intentional
  // (marketing redirect, not a new-tab escape hatch).
  const isExternal = /^https?:/i.test(safeLink);

  return (
    <>
      {children}
      <Link
        href={safeLink}
        aria-label={label}
        className="absolute inset-0 z-0"
        {...(isExternal ? { rel: 'noopener' } : {})}
      >
        <span className="sr-only">{label}</span>
      </Link>
    </>
  );
}
