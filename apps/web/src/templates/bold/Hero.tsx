'use client';

import Link from 'next/link';
import type { HeroProps } from '../types';

export default function BoldHero({
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
  const displayTitle = isRtl && titleAr ? titleAr : title || (isRtl ? 'اكتشف الجديد' : 'GO BOLD');
  const displaySubtitle = isRtl && subtitleAr ? subtitleAr : subtitle || (isRtl ? 'تميز بأسلوبك' : 'Stand out from the crowd');
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'تسوق الآن' : 'Shop Now');

  return (
    <section className="relative min-h-[100vh] bg-primary overflow-hidden" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Dynamic Background Pattern */}
      <div className="absolute inset-0 opacity-20">
        <div className="absolute top-0 left-0 w-96 h-96 bg-white rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-[600px] h-[600px] bg-black rounded-full blur-3xl translate-x-1/3 translate-y-1/3" />
        <div className="absolute top-1/2 left-1/2 w-72 h-72 bg-white rounded-full blur-2xl -translate-x-1/2 -translate-y-1/2" />
      </div>

      {/* Diagonal stripes pattern */}
      <div className="absolute inset-0 opacity-5">
        <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="bold-stripes" width="60" height="60" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="60" stroke="white" strokeWidth="20" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#bold-stripes)" />
        </svg>
      </div>

      <div className="container mx-auto px-4 h-full relative z-10">
        <div className="min-h-[100vh] flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-16 py-20">
          {/* Content */}
          <div className={`flex-1 ${isRtl ? 'lg:order-2' : 'lg:order-1'} text-center lg:text-left`}>
            {/* Animated Label */}
            <div className="inline-block mb-6 px-4 py-2 bg-white/10 backdrop-blur-sm rounded-full">
              <span className="text-sm font-bold text-white tracking-wider uppercase">
                {isRtl ? '✨ جديد' : '✨ New Drop'}
              </span>
            </div>

            {/* Title - Extra Bold */}
            <h1 className="text-6xl md:text-7xl lg:text-8xl xl:text-9xl font-black text-white leading-[0.9] tracking-tighter mb-6">
              {displayTitle.split(' ').map((word, i) => (
                <span key={i} className={`block ${i % 2 === 1 ? 'text-black/20' : ''}`}>
                  {word}
                </span>
              ))}
            </h1>

            {/* Subtitle */}
            <p className="text-xl md:text-2xl text-white/80 font-medium max-w-md mx-auto lg:mx-0 mb-10">
              {displaySubtitle}
            </p>

            {/* CTA Button - Chunky */}
            <Link
              href={ctaLink}
              className="inline-flex items-center gap-3 px-10 py-5 bg-white text-primary rounded-2xl font-black text-lg uppercase tracking-wider hover:bg-black hover:text-white transition-all duration-300 hover:scale-105 shadow-2xl shadow-black/30"
            >
              {displayCta}
              <svg
                className={`w-6 h-6 ${isRtl ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </Link>
          </div>

          {/* Image - Dynamic angle */}
          <div className={`flex-1 ${isRtl ? 'lg:order-1' : 'lg:order-2'} w-full max-w-lg lg:max-w-none`}>
            <div className="relative">
              {/* Background shape */}
              <div className="absolute inset-0 bg-white/10 rounded-3xl rotate-6 scale-105" />
              <div className="absolute inset-0 bg-black/20 rounded-3xl -rotate-3 scale-102" />

              {/* Image container */}
              <div className="relative aspect-square rounded-3xl overflow-hidden shadow-2xl">
                {image ? (
                  <img
                    src={image}
                    alt={displayTitle}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-white/10 flex items-center justify-center">
                    <div className="text-center p-8">
                      <div className="w-24 h-24 mx-auto mb-4 rounded-2xl bg-white/10 flex items-center justify-center">
                        <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <p className="text-white/70 font-bold">{isRtl ? 'صورة البانر' : 'Hero Image'}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Floating badge */}
              <div className="absolute -bottom-4 -left-4 px-6 py-3 bg-black text-white rounded-2xl font-bold shadow-xl">
                🔥 {isRtl ? 'رائج' : 'Trending'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
        <svg className="w-8 h-8 text-white/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </div>
    </section>
  );
}
