'use client';

import Link from 'next/link';
import Image from 'next/image';
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
}: HeroProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayTitle =
    isRtl && titleAr ? titleAr : title || (isRtl ? 'البساطة في التصميم' : 'Simply Beautiful');
  const displaySubtitle =
    isRtl && subtitleAr ? subtitleAr : subtitle || (isRtl ? 'أقل يعني أكثر' : 'Less is more');
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'تصفح' : 'Browse');

  return (
    <section className="bg-background" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Enormous headline block — maximum whitespace */}
      <div className="container mx-auto px-6 pt-12 pb-10 sm:pt-16 sm:pb-12 md:pt-20 md:pb-14 text-center">
        <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-light text-foreground tracking-tight leading-[1.05] mb-6 sm:mb-8 break-words">
          {displayTitle}
        </h1>

        <p className="text-base md:text-lg text-muted-foreground font-light max-w-sm mx-auto mb-8 sm:mb-10 leading-relaxed">
          {displaySubtitle}
        </p>

        {/* Minimal CTA — text link with arrow. min-h-11 keeps the tap target
            touch-friendly without violating the typographic minimalism. */}
        <Link
          href={ctaLink}
          className="group inline-flex min-h-11 items-center gap-2 px-3 py-3 text-[11px] tracking-[0.2em] uppercase text-foreground hover:text-primary transition-colors duration-200 cursor-pointer"
        >
          <span>{displayCta}</span>
          <svg
            className={`w-4 h-4 transition-transform duration-200 ${
              isRtl ? 'rotate-180 group-hover:-translate-x-0.5' : 'group-hover:translate-x-0.5'
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
