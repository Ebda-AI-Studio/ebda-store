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
  const displayTitle =
    isRtl && titleAr ? titleAr : title || (isRtl ? 'تشكيلة فاخرة' : 'Exquisite Collection');
  const displaySubtitle =
    isRtl && subtitleAr ? subtitleAr : subtitle || (isRtl ? 'أناقة لا تضاهى' : 'Timeless Elegance');
  const displayCta =
    isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'استكشف المجموعة' : 'Explore Collection');

  return (
    <section className="bg-white dark:bg-background overflow-hidden" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        <div className="grid lg:grid-cols-2 min-h-[560px] lg:min-h-[640px] items-center gap-0">
          {/* Text column */}
          <div
            className={`flex flex-col justify-center py-16 lg:py-24 ${
              isRtl ? 'lg:order-2 lg:pe-12' : 'lg:order-1 lg:pe-12'
            }`}
          >
            {/* Accent rule */}
            <div className={`w-12 h-px bg-foreground mb-8 ${isRtl ? 'ms-auto' : 'ms-0'}`} />

            {/* Serif heading */}
            <h1
              className={`text-4xl md:text-5xl lg:text-6xl font-serif font-normal text-foreground leading-[1.1] tracking-tight mb-6 ${
                isRtl ? 'text-right' : 'text-left'
              }`}
            >
              {displayTitle}
            </h1>

            {/* Subtitle */}
            <p
              className={`text-base md:text-lg text-muted-foreground font-light leading-relaxed mb-10 max-w-sm ${
                isRtl ? 'text-right ms-auto' : 'text-left'
              }`}
            >
              {displaySubtitle}
            </p>

            {/* CTA — outlined button with classic serif treatment */}
            <div className={isRtl ? 'text-right' : 'text-left'}>
              <Link
                href={ctaLink}
                className="group inline-flex items-center gap-3 border border-foreground px-8 py-3 font-serif text-sm tracking-widest uppercase text-foreground hover:bg-foreground hover:text-background transition-colors duration-300 cursor-pointer"
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

            {/* Established note */}
            <div className={`mt-14 ${isRtl ? 'text-right' : 'text-left'}`}>
              <span className="text-xs tracking-[0.3em] text-muted-foreground uppercase">
                {isRtl ? 'منذ ١٩٩٠' : 'Est. 1990'}
              </span>
            </div>
          </div>

          {/* Image column */}
          <div
            className={`relative hidden lg:block self-stretch ${isRtl ? 'lg:order-1' : 'lg:order-2'}`}
          >
            <div className="absolute inset-0 m-6">
              {image ? (
                <Image src={image} alt={displayTitle} fill className="object-cover" priority />
              ) : (
                <div className="w-full h-full bg-muted flex items-center justify-center">
                  <div className="text-center p-8">
                    <div className="w-16 h-16 mx-auto mb-4 border border-border flex items-center justify-center">
                      <svg
                        className="w-8 h-8 text-muted-foreground/40"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                        />
                      </svg>
                    </div>
                    <p className="text-xs text-muted-foreground tracking-widest uppercase">
                      {isRtl ? 'صورة البانر' : 'Hero Image'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
