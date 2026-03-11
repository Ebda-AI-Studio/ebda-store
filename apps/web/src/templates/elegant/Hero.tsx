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
}: HeroProps) {
  const displayTitle =
    isRtl && titleAr ? titleAr : title || (isRtl ? 'مجموعة حصرية' : 'Exclusive Edit');
  const displaySubtitle =
    isRtl && subtitleAr
      ? subtitleAr
      : subtitle || (isRtl ? 'أناقة استثنائية' : 'Curated for the discerning');
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'استكشف' : 'Discover');

  return (
    <section className="relative overflow-hidden" dir={isRtl ? 'rtl' : 'ltr'}>
      {image ? (
        /* With image: full-bleed hero */
        <div className="relative min-h-[70vh]">
          <div className="absolute inset-0">
            <Image src={image} alt={displayTitle} fill className="object-cover" />
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/80 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-t from-background/50 to-transparent" />
          </div>
          <div className="relative z-10 container mx-auto px-4 min-h-[70vh] flex items-center">
            <div className={`max-w-xl py-20 ${isRtl ? 'mr-0 ml-auto text-right' : 'ml-0'}`}>
              <p className="text-xs tracking-[0.4em] uppercase text-muted-foreground mb-8">
                {isRtl ? 'مجموعة جديدة' : 'New Collection'}
              </p>
              <h1 className="text-5xl md:text-6xl lg:text-7xl font-light text-foreground leading-[1.1] mb-8 tracking-[-0.02em]">
                {displayTitle.split(' ').map((word, i) => (
                  <span key={i}>
                    {i === 0 ? (
                      <span className="font-normal italic">{word}</span>
                    ) : (
                      <span> {word}</span>
                    )}
                  </span>
                ))}
              </h1>
              <div className={`w-16 h-px bg-primary/40 mb-8 ${isRtl ? 'mr-0 ml-auto' : ''}`} />
              <p className="text-lg text-muted-foreground font-light tracking-wide leading-relaxed mb-12 max-w-md">
                {displaySubtitle}
              </p>
              <Link
                href={ctaLink}
                className="group inline-flex items-center gap-4 px-8 py-4 bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-500"
              >
                <span className="text-sm tracking-[0.2em] uppercase font-medium">{displayCta}</span>
                <svg
                  className={`w-5 h-5 group-hover:translate-x-1 transition-transform ${isRtl ? 'rotate-180 group-hover:-translate-x-1' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
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
        /* No image: branded gradient hero with decorative elements */
        <div className="relative bg-gradient-to-br from-primary/8 via-background to-secondary/5">
          {/* Decorative elements */}
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-primary/5 blur-3xl" />
            <div className="absolute -bottom-24 -left-24 w-96 h-96 rounded-full bg-secondary/5 blur-3xl" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full border border-primary/5" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full border border-primary/8" />
          </div>

          <div className="relative z-10 container mx-auto px-4 py-24 md:py-32 lg:py-40">
            <div className={`max-w-2xl mx-auto text-center`}>
              <p className="text-xs tracking-[0.4em] uppercase text-primary/70 mb-8">
                {isRtl ? 'مجموعة جديدة' : 'New Collection'}
              </p>
              <h1 className="text-5xl md:text-6xl lg:text-7xl font-light text-foreground leading-[1.1] mb-8 tracking-[-0.02em]">
                {displayTitle.split(' ').map((word, i) => (
                  <span key={i}>
                    {i === 0 ? (
                      <span className="font-normal italic text-primary">{word}</span>
                    ) : (
                      <span> {word}</span>
                    )}
                  </span>
                ))}
              </h1>
              <div className="w-16 h-px bg-primary/40 mb-8 mx-auto" />
              <p className="text-lg text-muted-foreground font-light tracking-wide leading-relaxed mb-12 max-w-md mx-auto">
                {displaySubtitle}
              </p>
              <Link
                href={ctaLink}
                className="group inline-flex items-center gap-4 px-10 py-4 bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-500"
              >
                <span className="text-sm tracking-[0.2em] uppercase font-medium">{displayCta}</span>
                <svg
                  className={`w-5 h-5 group-hover:translate-x-1 transition-transform ${isRtl ? 'rotate-180 group-hover:-translate-x-1' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
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

          {/* Bottom info bar */}
          <div className="relative z-10 border-t border-primary/10">
            <div className="container mx-auto px-4 py-6">
              <div className="flex items-center justify-between text-xs tracking-[0.2em] uppercase text-muted-foreground">
                <span>{isRtl ? 'شحن مجاني' : 'Complimentary Shipping'}</span>
                <span className="text-primary/30">·</span>
                <span>{isRtl ? 'إرجاع سهل' : 'Easy Returns'}</span>
                <span className="hidden md:inline text-primary/30">·</span>
                <span className="hidden md:inline">
                  {isRtl ? 'خدمة متميزة' : 'White Glove Service'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
