'use client';

import Link from 'next/link';
import Image from 'next/image';
import { sanitizeUrl } from '@force/shared';
import type { HeroProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function MinimalHero({
  title,
  titleAr,
  subtitle,
  subtitleAr,
  image,
  ctaText,
  ctaTextAr,
  ctaLink = '/products',
  isRtl: isRtlProp,
  urlPrefix = '',
}: HeroProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  // No hardcoded marketing strings; merchant copy or nothing.
  const displayTitle = (isRtl && titleAr ? titleAr : title) ?? '';
  const displaySubtitle = (isRtl && subtitleAr ? subtitleAr : subtitle) ?? '';
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'تصفح' : 'Browse');
  // Defensive XSS guard: reject `javascript:`/`data:` schemes before the link
  // reaches an `<a href>`.
  const safeCtaLink = sanitizeUrl(ctaLink, '/products');
  const resolvedCtaLink =
    safeCtaLink.startsWith('/') && urlPrefix ? `${urlPrefix}${safeCtaLink}` : safeCtaLink;

  return (
    <section className="bg-background" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Enormous headline block — maximum whitespace */}
      <div className="container mx-auto px-6 pt-16 pb-12 sm:pt-20 sm:pb-14 md:pt-28 md:pb-16 lg:pt-32 lg:pb-20 text-center">
        <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-light text-foreground tracking-tight leading-[1.05] mb-6 sm:mb-8 break-words">
          {displayTitle}
        </h1>

        <p className="text-base md:text-lg text-muted-foreground font-light max-w-sm mx-auto mb-8 sm:mb-10 leading-relaxed">
          {displaySubtitle}
        </p>

        {/* Minimal CTA — text link with arrow. min-h-11 keeps the tap target
            touch-friendly without violating the typographic minimalism. */}
        <Link
          href={resolvedCtaLink}
          data-cta="link"
          className="group inline-flex min-h-[44px] items-center gap-2.5 px-3 py-3 text-sm tracking-[0.22em] uppercase text-foreground hover:text-primary transition-colors duration-500 ease-out cursor-pointer"
        >
          <span>{displayCta}</span>
          <svg
            className={`w-4 h-4 transition-transform duration-500 ease-out ${
              isRtl ? 'rotate-180 group-hover:-translate-x-1' : 'group-hover:translate-x-1'
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={1}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
          </svg>
        </Link>
      </div>

      {/* Full-bleed hero image — only rendered when configured. Without an
          image we let the typographic block stand on its own (Pecannbee
          treatment); a placeholder box would only make the page feel
          unfinished. */}
      {image && (
        <div className="relative aspect-[21/9] overflow-hidden bg-muted">
          <Image
            src={image}
            alt={displayTitle}
            fill
            sizes="100vw"
            className="object-cover"
            priority
          />
        </div>
      )}
    </section>
  );
}
