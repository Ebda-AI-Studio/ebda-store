'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { HeroBannerProps } from '../types';
import { getPackStyles } from './pack-styles';

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
}: HeroBannerProps) {
  const desktopSrc = (isRtl && imageAr) || image;
  // Mobile-specific source falls back to the desktop image when not set.
  const dedicatedMobileSrc = (isRtl && imageMobileAr) || imageMobile;
  const mobileSrc = dedicatedMobileSrc || desktopSrc;
  // Mobile aspect tracks what the merchant actually uploaded:
  //   - dedicated mobile image present → 3:4 portrait (matches the admin
  //     ImageUpload's aspectRatio="3/4" + server-side sharp resize). Using
  //     a landscape wrapper here crops the top of the image — verified
  //     2026-05-17 with wadyaljuz's olive-jar banner where the title
  //     "من الوادي إلى الأيادي" was being cut off at the top.
  //   - only desktop image present → 3:2 landscape so the wide cinematic
  //     crop renders sensibly on mobile without huge letterbox bars.
  // Desktop stays at 2.4:1 either way.
  const mobileAspectClass = dedicatedMobileSrc ? 'aspect-[3/4]' : 'aspect-[3/2]';
  const text = isRtl ? (headlineAr ?? headline) : (headline ?? headlineAr);
  const subtitleText = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);
  const cta = isRtl ? (ctaTextAr ?? ctaText) : (ctaText ?? ctaTextAr);
  const showOverlay = !!(text || subtitleText || cta);
  const styles = getPackStyles(pack);

  return (
    <section
      className={`relative w-full overflow-hidden bg-muted ${mobileAspectClass} sm:aspect-[2.4/1]`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
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
            // Back to object-cover after backend auto-resize landed (commit
            // b463fed). New uploads through the admin are now resized to the
            // exact container aspect (3:2 mobile / 2.4:1 desktop) via sharp
            // before saving to R2, so object-cover trims zero pixels for
            // any post-auto-resize upload. For images uploaded BEFORE the
            // auto-resize feature (legacy R2 assets), object-cover will
            // crop slightly — merchants can re-upload via admin → hero
            // page to get edge-to-edge perfect fit.
            className="object-cover"
          />
        </picture>
      )}

      {showOverlay && (
        <div className={`absolute inset-0 flex items-center justify-center ${styles.heroOverlay}`}>
          <div className="mx-auto max-w-3xl px-6 text-center">
            {text && <h1 className={styles.heroHeadline}>{text}</h1>}
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
}
