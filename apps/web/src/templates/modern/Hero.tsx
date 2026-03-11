'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { HeroProps } from '../types';

export default function ModernHero({
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
    isRtl && titleAr
      ? titleAr
      : title || (isRtl ? 'اكتشف مجموعتنا الجديدة' : 'Discover Our New Collection');
  const displaySubtitle =
    isRtl && subtitleAr
      ? subtitleAr
      : subtitle || (isRtl ? 'منتجات مميزة بأفضل الأسعار' : 'Premium products at the best prices');
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'تسوق الآن' : 'Shop Now');

  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-primary/10 to-primary/5">
      <div className="container mx-auto px-4">
        <div className="grid lg:grid-cols-2 gap-8 items-center min-h-[500px] py-12 lg:py-20">
          {/* Content */}
          <div className={`space-y-6 ${isRtl ? 'lg:order-2 text-right' : 'lg:order-1'}`}>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-foreground leading-tight">
              {displayTitle}
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground max-w-lg">{displaySubtitle}</p>
            <div className="flex flex-wrap gap-4">
              <Link
                href={ctaLink}
                className="inline-flex items-center gap-2 px-8 py-4 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all hover:scale-105 font-semibold text-lg shadow-lg shadow-primary/25"
              >
                {displayCta}
                <svg
                  className={`w-5 h-5 ${isRtl ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              </Link>
            </div>
          </div>

          {/* Image */}
          <div className={`relative ${isRtl ? 'lg:order-1' : 'lg:order-2'}`}>
            <div className="relative aspect-[4/3] rounded-2xl overflow-hidden shadow-2xl">
              {image ? (
                <Image src={image} alt={displayTitle} fill className="object-cover" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                  <div className="text-center p-8">
                    <div className="w-24 h-24 mx-auto mb-4 rounded-2xl bg-primary/10 flex items-center justify-center">
                      <svg
                        className="w-12 h-12 text-primary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                        />
                      </svg>
                    </div>
                    <p className="text-muted-foreground">{isRtl ? 'صورة البانر' : 'Hero Image'}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Decorative Elements */}
            <div className="absolute -top-4 -right-4 w-24 h-24 bg-primary/10 rounded-full blur-2xl" />
            <div className="absolute -bottom-8 -left-8 w-32 h-32 bg-primary/10 rounded-full blur-3xl" />
          </div>
        </div>
      </div>

      {/* Background Pattern */}
      <div className="absolute inset-0 opacity-5 pointer-events-none">
        <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="modern-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#modern-grid)" />
        </svg>
      </div>
    </section>
  );
}
