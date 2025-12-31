'use client';

import Link from 'next/link';
import type { HeroProps } from '../types';

export default function ClassicHero({
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
  const displayTitle = isRtl && titleAr ? titleAr : title || (isRtl ? 'تشكيلة فاخرة' : 'Exquisite Collection');
  const displaySubtitle = isRtl && subtitleAr ? subtitleAr : subtitle || (isRtl ? 'أناقة لا تضاهى' : 'Timeless Elegance');
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'استكشف المجموعة' : 'Explore Collection');

  return (
    <section className="relative min-h-[600px] lg:min-h-[700px] bg-background overflow-hidden">
      {/* Decorative Border Frame */}
      <div className="absolute inset-4 md:inset-8 border border-border/50 pointer-events-none" />
      <div className="absolute inset-6 md:inset-12 border border-border/30 pointer-events-none" />

      <div className="container mx-auto px-4 h-full">
        <div className="grid lg:grid-cols-2 gap-0 min-h-[600px] lg:min-h-[700px]">
          {/* Content - Centered with elegant typography */}
          <div className={`flex flex-col justify-center py-16 lg:py-24 ${isRtl ? 'lg:order-2 lg:pr-12' : 'lg:order-1 lg:pl-4'}`}>
            {/* Decorative Line */}
            <div className={`w-16 h-px bg-primary mb-8 ${isRtl ? 'mr-0 ml-auto' : 'ml-0'}`} />

            {/* Title with Serif Styling */}
            <h1
              className={`text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-serif font-normal text-foreground leading-[1.1] tracking-tight mb-6 ${isRtl ? 'text-right' : 'text-left'}`}
            >
              {displayTitle}
            </h1>

            {/* Subtitle */}
            <p
              className={`text-lg md:text-xl text-muted-foreground font-light tracking-wide mb-10 max-w-md ${isRtl ? 'text-right mr-0 ml-auto' : 'text-left'}`}
            >
              {displaySubtitle}
            </p>

            {/* CTA Button - Elegant underline style */}
            <div className={`${isRtl ? 'text-right' : 'text-left'}`}>
              <Link
                href={ctaLink}
                className="group inline-flex items-center gap-4 text-foreground font-medium tracking-widest uppercase text-sm border-b-2 border-foreground pb-2 hover:border-primary hover:text-primary transition-colors duration-300"
              >
                <span>{displayCta}</span>
                <svg
                  className={`w-5 h-5 group-hover:translate-x-1 transition-transform ${isRtl ? 'rotate-180 group-hover:-translate-x-1' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>

            {/* Decorative Element */}
            <div className={`mt-16 ${isRtl ? 'text-right' : 'text-left'}`}>
              <span className="text-xs tracking-[0.3em] text-muted-foreground uppercase">
                {isRtl ? 'منذ ١٩٩٠' : 'Est. 1990'}
              </span>
            </div>
          </div>

          {/* Image - Full height with elegant frame */}
          <div className={`relative ${isRtl ? 'lg:order-1' : 'lg:order-2'} hidden lg:block`}>
            <div className="absolute inset-0 m-8">
              {image ? (
                <img
                  src={image}
                  alt={displayTitle}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-muted flex items-center justify-center">
                  <div className="text-center p-8">
                    <div className="w-20 h-20 mx-auto mb-4 border border-border/50 flex items-center justify-center">
                      <svg className="w-10 h-10 text-muted-foreground/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-muted-foreground text-sm tracking-wide">{isRtl ? 'صورة البانر' : 'Hero Image'}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Overlay Pattern */}
            <div className="absolute inset-0 m-8 bg-gradient-to-l from-transparent via-transparent to-background/20 pointer-events-none" />
          </div>
        </div>
      </div>

      {/* Corner Ornaments */}
      <div className="absolute top-12 left-12 w-8 h-8 border-l-2 border-t-2 border-border/40" />
      <div className="absolute top-12 right-12 w-8 h-8 border-r-2 border-t-2 border-border/40" />
      <div className="absolute bottom-12 left-12 w-8 h-8 border-l-2 border-b-2 border-border/40" />
      <div className="absolute bottom-12 right-12 w-8 h-8 border-r-2 border-b-2 border-border/40" />
    </section>
  );
}
