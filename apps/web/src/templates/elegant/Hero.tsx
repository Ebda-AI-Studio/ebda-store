'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { HeroProps } from '../types';

export default function ElegantHero({
  title,
  titleAr,
  subtitle,
  subtitleAr,
  image,
  ctaText,
  ctaTextAr,
  ctaLink = '/products',
  isRtl = false,
  urlPrefix = '',
}: HeroProps) {
  const displayTitle =
    isRtl && titleAr ? titleAr : title || (isRtl ? 'مجموعة حصرية' : 'Exclusive Edit');
  const displaySubtitle =
    isRtl && subtitleAr
      ? subtitleAr
      : subtitle || (isRtl ? 'أناقة استثنائية' : 'Curated for the discerning');
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'استكشف' : 'Discover');

  const resolvedCtaLink = ctaLink.startsWith('/') && urlPrefix ? `${urlPrefix}${ctaLink}` : ctaLink;

  return (
    <section
      className="relative overflow-hidden"
      dir={isRtl ? 'rtl' : 'ltr'}
      style={{ animation: 'elegantFadeIn 0.5s ease-out both' }}
    >
      {image ? (
        /* Asymmetric layout: image 60% + text 40% */
        <div className="flex flex-col lg:flex-row min-h-[85vh]">
          {/* Image side — 60% */}
          <div
            className={`relative w-full lg:w-[60%] min-h-[50vh] lg:min-h-full ${isRtl ? 'lg:order-2' : 'lg:order-1'} overflow-hidden`}
          >
            <Image src={image} alt={displayTitle} fill className="object-cover" priority />
            <div className="absolute inset-0 bg-foreground/10" />
          </div>

          {/* Text side — 40% */}
          <div
            className={`w-full lg:w-[40%] bg-background flex items-center ${isRtl ? 'lg:order-1' : 'lg:order-2'}`}
          >
            <div
              className={`px-8 md:px-12 lg:px-16 py-16 max-w-lg ${isRtl ? 'text-right mr-auto' : 'text-left'}`}
            >
              <p className="text-[10px] tracking-[0.5em] uppercase text-muted-foreground/60 mb-10">
                {isRtl ? 'مجموعة جديدة' : 'New Collection'}
              </p>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-light text-foreground leading-[1.1] tracking-[-0.02em] mb-8">
                <span className="italic font-normal">
                  {displayTitle.split(' ').slice(0, 1).join(' ')}
                </span>
                {displayTitle.split(' ').length > 1 && (
                  <span className="block font-extralight">
                    {displayTitle.split(' ').slice(1).join(' ')}
                  </span>
                )}
              </h1>
              <div className={`w-12 h-px bg-foreground/20 mb-8 ${isRtl ? 'mr-0 ml-auto' : ''}`} />
              <p className="text-sm text-muted-foreground font-light tracking-wide leading-loose mb-12 max-w-xs">
                {displaySubtitle}
              </p>
              <Link
                href={resolvedCtaLink}
                className="group inline-flex items-center gap-4 px-8 py-4 border border-foreground text-foreground text-xs tracking-[0.25em] uppercase font-medium hover:bg-foreground hover:text-background transition-all duration-500 cursor-pointer"
              >
                {displayCta}
                <svg
                  className={`w-4 h-4 transition-transform duration-500 ${isRtl ? 'rotate-180 group-hover:-translate-x-1' : 'group-hover:translate-x-1'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      ) : (
        /* No image: centered editorial layout */
        <div className="relative bg-gradient-to-b from-primary/5 via-background to-background">
          {/* Subtle decorative rings */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] rounded-full border border-primary/5" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[450px] h-[450px] rounded-full border border-primary/8" />
          </div>

          <div className="relative z-10 container mx-auto px-4 py-28 md:py-36 lg:py-44">
            <div className="max-w-2xl mx-auto text-center">
              <p className="text-[10px] tracking-[0.5em] uppercase text-primary/50 mb-10">
                {isRtl ? 'مجموعة جديدة' : 'New Collection'}
              </p>
              <h1 className="text-5xl md:text-6xl lg:text-7xl font-light text-foreground leading-[1.1] tracking-[-0.02em] mb-8">
                <span className="italic font-normal text-primary">
                  {displayTitle.split(' ').slice(0, 1).join(' ')}
                </span>
                {displayTitle.split(' ').length > 1 && (
                  <span className="block font-extralight">
                    {displayTitle.split(' ').slice(1).join(' ')}
                  </span>
                )}
              </h1>
              <div className="w-12 h-px bg-primary/30 mb-8 mx-auto" />
              <p className="text-sm text-muted-foreground font-light tracking-wide leading-loose mb-12 max-w-md mx-auto">
                {displaySubtitle}
              </p>
              <Link
                href={resolvedCtaLink}
                className="group inline-flex items-center gap-4 px-10 py-4 border border-foreground text-foreground text-xs tracking-[0.25em] uppercase font-medium hover:bg-foreground hover:text-background transition-all duration-500 cursor-pointer"
              >
                {displayCta}
                <svg
                  className={`w-4 h-4 transition-transform duration-500 ${isRtl ? 'rotate-180 group-hover:-translate-x-1' : 'group-hover:translate-x-1'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              </Link>
            </div>
          </div>

          {/* Bottom perks bar */}
          <div className="border-t border-primary/8">
            <div className="container mx-auto px-4 py-5">
              <div className="flex items-center justify-between text-[10px] tracking-[0.2em] uppercase text-muted-foreground/50">
                <span>{isRtl ? 'شحن مجاني' : 'Complimentary Shipping'}</span>
                <span className="text-primary/20">·</span>
                <span>{isRtl ? 'إرجاع سهل' : 'Easy Returns'}</span>
                <span className="hidden md:inline text-primary/20">·</span>
                <span className="hidden md:inline">
                  {isRtl ? 'خدمة متميزة' : 'White Glove Service'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes elegantFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </section>
  );
}
