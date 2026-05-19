'use client';

import type React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { HeroBannerProps } from '../types';
import { getPackStyles } from './pack-styles';
import { responsiveFontSize } from './section-typography';

/**
 * Single hero banner — full-bleed image, optional headline overlay + CTA.
 * Per-pack typography & CTA style via `pack` so each template's voice is
 * preserved (Bold uppercase / Classic serif / Elegant extralight / etc.).
 *
 * 2.45:1 aspect matches Pecannbee spec and the `sizing.heroAspect` default.
 */
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
  // Mobile hero is always LANDSCAPE — Ahmad 2026-05-18 directive
  // "the mobile hero banner i want it horizontal not vertical or
  // portrait". Container aspect matches the desktop image (1920:700)
  // so the same landscape banner renders edge-to-edge with no side
  // crop on either breakpoint. The dedicated mobile image upload is
  // still honored as a source override (different content / higher-res
  // close-up) — but it's rendered in the same landscape container.
  // Merchants should now upload mobile-specific images in landscape
  // crops, not portrait. Old portrait crops (if any merchant uploaded
  // one) will get letterboxed top + bottom on mobile.
  const mobileAspectClass = 'aspect-[1920/700]';
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
  const containerClass = isFramed
    ? 'relative w-full overflow-hidden rounded-2xl bg-muted ' +
      mobileAspectClass +
      ' sm:aspect-[1920/700]'
    : 'relative w-full overflow-hidden bg-muted ' + mobileAspectClass + ' sm:aspect-[1920/700]';
  const imageObjectClass = isFramed ? 'object-contain' : 'object-cover';

  const heroSection = (
    <section className={containerClass} dir={isRtl ? 'rtl' : 'ltr'}>
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
            // upload at the exact container aspect (3:2 mobile / 1920×700
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
