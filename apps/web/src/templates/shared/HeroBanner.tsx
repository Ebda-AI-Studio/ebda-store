'use client';

import type React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { IMAGE_STANDARDS, sanitizeUrl } from '@force/shared';
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

  // Mobile hero aspect: derived from IMAGE_STANDARDS.heroMobile via a CSS
  // CUSTOM PROPERTY consumed by the `aspect-[var(--hero-m-aspect)]` class, so
  // the shared standard still drives it WITHOUT drifting AND the desktop
  // `sm:aspect-[1920/700]` class can override it on ≥640px.
  //
  // 2026-06-04: this was previously an inline `style={{ aspectRatio }}`, which
  // ALWAYS beats a Tailwind class regardless of media query — inline styles
  // win the cascade. So `sm:aspect-[1920/700]` never applied and the DESKTOP
  // banner was stuck at whatever mobile aspect was last set (the live A/B
  // mobile-aspect tests #49–#52 leaked onto desktop — "mobile banner showing
  // on desktop", Ahmad). A custom property is just a value, not an
  // aspect-ratio declaration, so the responsive class override works normally.
  // max-h-[45vh] caps the banner on larger phones/tablets so categories below
  // remain visible. Upload hint: heroMobile for dedicated mobile images;
  // 1920×700 desktop images center-crop cleanly via object-cover.
  const mobileAspectStyle = {
    '--hero-m-aspect': `${HERO_MOBILE.width} / ${HERO_MOBILE.height}`,
  } as React.CSSProperties;

  const text = isRtl ? (headlineAr ?? headline) : (headline ?? headlineAr);
  const subtitleText = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);
  const cta = isRtl ? (ctaTextAr ?? ctaText) : (ctaText ?? ctaTextAr);
  const showOverlay = !!(text || subtitleText || cta);
  const styles = getPackStyles(pack);

  // Resolve hero headline color at runtime so it is never hardcoded to white.
  // Priority order:
  //   1. Merchant typography-zone override (headingZone?.color) — explicit pick wins.
  //   2. pickReadableForeground against white — the hero background is always an
  //      image so there is no solid-color bg to analyse. We default the analysis
  //      bg to '#ffffff' which returns '#000000', but that would be wrong on a
  //      dark photo. For image heroes the safe default is '#ffffff' (white on imagery
  //      is the industry convention; the gradient overlay in heroOverlay adds further
  //      scrim). We therefore skip the luminance check for image heroes and just
  //      use '#ffffff' as the fallback, matching the original text-white intent.
  //
  // NOTE: if a future caller ever passes a solid bgColor prop we can switch to
  //       pickReadableForeground(resolveColor(bgColor, theme) ?? '#000000') here.
  const heroColor: string = headingZone?.color ?? '#ffffff';

  // Framed mode (Ahmad 2026-05-17 night): merchant uploaded an image
  // they want shown in FULL without crop. Sit the hero inside a
  // max-w-7xl container with horizontal padding + rounded-2xl frame +
  // neutral bg, render image with object-contain so the whole asset
  // displays (may letterbox at the sides on portrait-ish sources).
  // Full-bleed mode (default, pre-existing behavior): edge-to-edge,
  // object-cover. Both modes share the same aspect ratio wrappers.
  const containerBaseClass = isFramed
    ? 'relative w-full overflow-hidden rounded-2xl bg-muted aspect-[var(--hero-m-aspect)] max-h-[45vh] sm:aspect-[1920/700] sm:max-h-none'
    : 'relative w-full overflow-hidden bg-muted aspect-[var(--hero-m-aspect)] max-h-[45vh] sm:aspect-[1920/700] sm:max-h-none';
  const imageObjectClass = isFramed ? 'object-contain' : 'object-cover';

  const heroSection = (
    // Mobile: aspect-[var(--hero-m-aspect)] (value supplied via style) + 45vh ceiling.
    // Desktop (sm:): sm:aspect-[1920/700] overrides the base class via media query —
    // both are classes now, so the later sm: utility wins (no inline-style override
    // trap). sm:max-h-none removes the mobile ceiling. overflow-hidden clips both.
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
                  // heroColor is always defined: merchant pick OR '#ffffff' fallback.
                  // This replaces the removed `text-white` in heroHeadline pack-styles
                  // so every theme still gets a legible color without a hardcoded class.
                  color: heroColor,
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
                href={sanitizeUrl(ctaHref)}
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
