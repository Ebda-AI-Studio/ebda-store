'use client';

import type React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { IMAGE_STANDARDS } from '@force/shared';
import type { HeroBannerProps } from '../types';
import { getPackStyles } from './pack-styles';
import { responsiveFontSize } from './section-typography';

/**
 * Single hero banner — full-bleed image, optional headline overlay + CTA.
 * Per-pack typography & CTA style via `pack` so each template's voice is
 * preserved (Bold uppercase / Classic serif / Elegant extralight / etc.).
 *
 * Mobile aspect ratio is derived from IMAGE_STANDARDS.heroMobile (single
 * source of truth in packages/shared) so the render and the admin upload
 * hint can never drift from each other.
 */

// Single source of truth: mobile aspect derived from the shared standard.
// Change heroMobile in image-standards.ts and both the admin hint and the
// storefront render update automatically.
const HERO_MOBILE = IMAGE_STANDARDS.heroMobile;

export function HeroBanner({
  image,
  imageAr,
  imageMobile,
  imageMobileAr,
  alt = '',
  headline,
  headlineAr,
  subtitle,
  subtitleAr,
  ctaText,
  ctaTextAr,
  ctaHref,
  isRtl,
  pack,
  priority = true,
  presentation = 'full-bleed',
  headingZone,
}: HeroBannerProps) {
  const isFramed = presentation === 'framed';
  const desktopSrc = (isRtl && imageAr) || image;
  // Mobile-specific source falls back to the desktop image when not set.
  const dedicatedMobileSrc = (isRtl && imageMobileAr) || imageMobile;
  const mobileSrc = dedicatedMobileSrc || desktopSrc;

  // Mobile hero aspect: derived from IMAGE_STANDARDS.heroMobile (16:9, 1200×675)
  // via inline style so Tailwind can't hard-code a ratio that drifts from the
  // shared standard. max-h-[45vh] caps the banner on larger phones/tablets so
  // categories below remain visible without scrolling past the fold.
  // Desktop (sm: 640px+) keeps the canonical 1920×700 (2.74:1) aspect —
  // unchanged from prior behaviour; only the mobile breakpoint uses 16:9.
  // Upload hint: 1200×675 for dedicated mobile images; 1920×700 desktop images
  // will center-crop cleanly via object-cover.
  const mobileAspectStyle = { aspectRatio: `${HERO_MOBILE.width} / ${HERO_MOBILE.height}` };

  const text = isRtl ? (headlineAr ?? headline) : (headline ?? headlineAr);
  const subtitleText = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);
  const cta = isRtl ? (ctaTextAr ?? ctaText) : (ctaText ?? ctaTextAr);
  const showOverlay = !!(text || subtitleText || cta);
  const styles = getPackStyles(pack);

  // Framed mode (Ahmad 2026-05-17 night): merchant uploaded an image
  // they want shown in FULL without crop. Sit the hero inside a
  // max-w-7xl container with horizontal padding + rounded-2xl frame +
  // neutral bg, render image with object-contain so the whole asset
  // displays (may letterbox at the sides on portrait-ish sources).
  // Full-bleed mode (default, pre-existing behavior): edge-to-edge,
  // object-cover. Both modes share the same aspect ratio wrappers.
  const containerBaseClass = isFramed
    ? 'relative w-full overflow-hidden rounded-2xl bg-muted max-h-[45vh] sm:aspect-[1920/700] sm:max-h-none'
    : 'relative w-full overflow-hidden bg-muted max-h-[45vh] sm:aspect-[1920/700] sm:max-h-none';
  const imageObjectClass = isFramed ? 'object-contain' : 'object-cover';

  const heroSection = (
    // Mobile: aspectRatio from inline style (derived from heroMobile standard) + 45vh ceiling.
    // Desktop (sm:): Tailwind sm:aspect-[1920/700] activates via media query — the inline
    // aspectRatio is overridden by the sm: class on modern browsers (class wins over
    // inline style when specificity is equal and the media query is active). sm:max-h-none
    // removes the mobile ceiling. overflow-hidden on the outer section clips both.
    <section className={containerBaseClass} style={mobileAspectStyle} dir={isRtl ? 'rtl' : 'ltr'}>
      {desktopSrc && (
        <picture>
          <source media="(max-width: 639px)" srcSet={mobileSrc} />
          <Image
            src={desktopSrc}
            alt={alt}
            fill
            priority={priority}
            loading={priority ? undefined : 'lazy'}
            sizes="100vw"
            // object-cover (full-bleed): backend auto-resize lands every new
            // upload at the exact container aspect (16:9 mobile / 1920×700
            // desktop) via sharp before R2, so cover trims zero pixels for
            // post-auto-resize uploads. Pre-feature legacy assets may crop
            // slightly.
            // object-contain (framed): whole image displays inside the
            // container, letterbox bars fill with the neutral bg above.
            // Pick by `presentation` prop / merchant admin toggle.
            className={imageObjectClass}
          />
        </picture>
      )}

      {showOverlay && (
        <div className={`absolute inset-0 flex items-center justify-center ${styles.heroOverlay}`}>
          <div className="mx-auto max-w-3xl px-6 text-center">
            {text && (
              <h1
                className={styles.heroHeadline}
                data-zone="heroHeadline"
                style={{
                  fontFamily: headingZone?.fontFamily,
                  fontSize: responsiveFontSize(headingZone?.fontSize),
                  fontWeight: headingZone?.fontWeight,
                  color: headingZone?.color,
                  letterSpacing: headingZone?.letterSpacing,
                  lineHeight: headingZone?.lineHeight,
                  textTransform: headingZone?.textTransform as React.CSSProperties['textTransform'],
                }}
              >
                {text}
              </h1>
            )}
            {subtitleText && (
              <p className="mt-3 text-base sm:text-lg text-white/90 drop-shadow">{subtitleText}</p>
            )}
            {cta && ctaHref && (
              <Link
                href={ctaHref}
                className={`mt-6 inline-flex items-center justify-center ${styles.heroCta}`}
                data-cta="button"
              >
                {cta}
              </Link>
            )}
          </div>
        </div>
      )}
    </section>
  );

  return isFramed ? (
    <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6">{heroSection}</div>
  ) : (
    heroSection
  );
}
