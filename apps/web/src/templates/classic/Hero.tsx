'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { HeroProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ClassicHero({
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
  // No hardcoded marketing fallbacks — empty values render nothing so the
  // merchant's own copy isn't competing with template demo strings.
  const displayTitle = (isRtl && titleAr ? titleAr : title) ?? '';
  const displaySubtitle = (isRtl && subtitleAr ? subtitleAr : subtitle) ?? '';
  // CTA falls back to a generic button label since it's functional UI.
  const displayCta =
    isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'استكشف المجموعة' : 'Explore Collection');

  return (
    <section className="bg-white dark:bg-background overflow-hidden" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        <div
          className={`grid min-h-[480px] lg:min-h-[640px] items-center gap-0 ${
            image ? 'lg:grid-cols-2' : 'lg:grid-cols-1'
          }`}
        >
          {/* Text column */}
          <div
            className={`flex flex-col justify-center py-16 sm:py-20 lg:py-28 ${
              image
                ? isRtl
                  ? 'lg:order-2 lg:pe-12'
                  : 'lg:order-1 lg:pe-12'
                : 'mx-auto w-full max-w-2xl items-center text-center'
            }`}
          >
            {/* Accent rule */}
            <div
              className={`w-12 h-px bg-foreground mb-8 ${
                image ? (isRtl ? 'ms-auto' : 'ms-0') : 'mx-auto'
              }`}
            />

            {/* Serif heading */}
            <h1
              className={`text-4xl md:text-5xl lg:text-6xl font-serif font-normal text-foreground leading-[1.1] tracking-tight mb-6 ${
                image ? (isRtl ? 'text-right' : 'text-left') : 'text-center'
              }`}
            >
              {displayTitle}
            </h1>

            {/* Subtitle */}
            <p
              className={`text-base md:text-lg text-muted-foreground font-light leading-relaxed mb-10 max-w-sm ${
                image ? (isRtl ? 'text-right ms-auto' : 'text-left') : 'text-center mx-auto'
              }`}
            >
              {displaySubtitle}
            </p>

            {/* CTA — outlined button with classic serif treatment */}
            <div className={image ? (isRtl ? 'text-right' : 'text-left') : 'text-center'}>
              <Link
                href={ctaLink}
                className="group inline-flex min-h-[44px] items-center gap-3 border border-foreground px-9 py-3.5 font-serif text-sm tracking-[0.22em] uppercase text-foreground hover:bg-foreground hover:text-background transition-colors duration-500 ease-out cursor-pointer"
              >
                <span>{displayCta}</span>
                <svg
                  className={`w-4 h-4 transition-transform duration-300 ${
                    isRtl ? 'rotate-180 group-hover:-translate-x-1' : 'group-hover:translate-x-1'
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              </Link>
            </div>

            {/* "Est. 1990" used to live here — removed because it was a
                hardcoded demo string that's not true for every tenant. If
                we want to surface the founding year again later, gate it
                on a real `store.foundedYear` field. */}
          </div>

          {/* Image column — only render when an image is configured. */}
          {image && (
            <div className={`relative self-stretch ${isRtl ? 'lg:order-1' : 'lg:order-2'}`}>
              <div className="absolute inset-0 m-6">
                <Image
                  src={image}
                  alt={displayTitle}
                  fill
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  className="object-cover"
                  priority
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
