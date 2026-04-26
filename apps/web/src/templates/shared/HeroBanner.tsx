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
  const src = (isRtl && imageAr) || image;
  const text = isRtl ? (headlineAr ?? headline) : (headline ?? headlineAr);
  const subtitleText = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);
  const cta = isRtl ? (ctaTextAr ?? ctaText) : (ctaText ?? ctaTextAr);
  const showOverlay = !!(text || subtitleText || cta);
  const styles = getPackStyles(pack);

  return (
    <section
      className="relative w-full overflow-hidden bg-muted"
      style={{ aspectRatio: '2.45 / 1' }}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {src && (
        <Image
          src={src}
          alt={alt}
          fill
          priority={priority}
          loading={priority ? undefined : 'lazy'}
          sizes="100vw"
          className="object-cover"
        />
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
