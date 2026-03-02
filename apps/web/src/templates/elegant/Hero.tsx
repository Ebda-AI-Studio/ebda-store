'use client';

import Link from 'next/link';
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
    <section
      className="relative min-h-screen bg-background overflow-hidden"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {/* Full-bleed image */}
      <div className="absolute inset-0">
        {image ? (
          <img src={image} alt={displayTitle} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-primary/10 via-secondary/5 to-background" />
        )}
        {/* Sophisticated overlay */}
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/80 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-background/50 to-transparent" />
      </div>

      {/* Content */}
      <div className="relative z-10 container mx-auto px-4 min-h-screen flex items-center">
        <div className={`max-w-xl py-20 ${isRtl ? 'mr-0 ml-auto text-right' : 'ml-0'}`}>
          {/* Subtle label */}
          <p className="text-xs tracking-[0.4em] uppercase text-muted-foreground mb-8">
            {isRtl ? 'مجموعة جديدة' : 'New Collection'}
          </p>

          {/* Title - Editorial style */}
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

          {/* Divider */}
          <div className={`w-16 h-px bg-foreground/20 mb-8 ${isRtl ? 'mr-0 ml-auto' : ''}`} />

          {/* Subtitle */}
          <p className="text-lg text-muted-foreground font-light tracking-wide leading-relaxed mb-12 max-w-md">
            {displaySubtitle}
          </p>

          {/* CTA - Refined button */}
          <Link
            href={ctaLink}
            className="group inline-flex items-center gap-4 px-8 py-4 border border-foreground text-foreground hover:bg-foreground hover:text-background transition-all duration-500"
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
      <div className="absolute bottom-0 left-0 right-0 z-20">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center justify-between text-xs tracking-[0.2em] uppercase text-muted-foreground">
            <span>{isRtl ? 'شحن مجاني' : 'Complimentary Shipping'}</span>
            <span>·</span>
            <span>{isRtl ? 'إرجاع سهل' : 'Easy Returns'}</span>
            <span className="hidden md:inline">·</span>
            <span className="hidden md:inline">
              {isRtl ? 'خدمة متميزة' : 'White Glove Service'}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
