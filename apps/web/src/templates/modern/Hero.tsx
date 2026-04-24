'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { HeroProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ModernHero({
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
    isRtl && titleAr
      ? titleAr
      : title || (isRtl ? 'اكتشف مجموعتنا الجديدة' : 'Discover Our New Collection');
  const displaySubtitle =
    isRtl && subtitleAr
      ? subtitleAr
      : subtitle || (isRtl ? 'منتجات مميزة بأفضل الأسعار' : 'Premium products at the best prices');
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'تسوق الآن' : 'Shop Now');

  return (
    <section className="relative overflow-hidden bg-background">
      <div className="container mx-auto px-4">
        <div
          className={`grid lg:grid-cols-2 gap-8 lg:gap-12 items-center min-h-[540px] py-14 lg:py-24 ${isRtl ? 'direction-rtl' : ''}`}
        >
          {/* Content */}
          <div
            className={`space-y-7 ${isRtl ? 'lg:order-2 text-right' : 'lg:order-1'} motion-safe:[animation:heroFadeIn_0.7s_ease-out_both] motion-reduce:opacity-100`}
          >
            <div className="space-y-4">
              <h1
                className="text-4xl md:text-5xl lg:text-6xl font-extrabold leading-[1.1] tracking-tight text-foreground"
                style={{ letterSpacing: '-0.02em' }}
              >
                <span className="bg-gradient-to-r from-primary via-primary/80 to-primary/60 bg-clip-text text-transparent">
                  {displayTitle}
                </span>
              </h1>
              <p className="text-lg md:text-xl text-muted-foreground max-w-md leading-relaxed">
                {displaySubtitle}
              </p>
            </div>

            <div
              className={`flex flex-col sm:flex-row gap-3 ${isRtl ? 'items-end sm:flex-row-reverse' : 'items-start'}`}
            >
              <Link
                href={ctaLink}
                className="group inline-flex items-center gap-2.5 px-8 py-4 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 font-semibold text-base shadow-lg shadow-primary/20 transition-all duration-300 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-0.5 w-full sm:w-auto justify-center"
              >
                {displayCta}
                <svg
                  className={`w-4 h-4 transition-transform duration-300 group-hover:translate-x-1 ${isRtl ? 'rotate-180 group-hover:-translate-x-1 group-hover:translate-x-0' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              </Link>
            </div>
          </div>

          {/* Image */}
          <div
            className={`relative ${isRtl ? 'lg:order-1' : 'lg:order-2'} motion-safe:[animation:heroFadeIn_0.7s_ease-out_0.15s_both] motion-reduce:opacity-100`}
          >
            <div className="relative aspect-[4/3] lg:aspect-[5/4] rounded-2xl overflow-hidden shadow-2xl shadow-black/10">
              {image ? (
                <>
                  <Image
                    src={image}
                    alt={displayTitle}
                    fill
                    sizes="(min-width: 1024px) 50vw, 100vw"
                    className="object-cover"
                    priority
                  />
                  {/* Gradient overlay on image */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent" />
                </>
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-primary/15 via-primary/8 to-muted flex items-center justify-center">
                  <div className="text-center p-8 space-y-3">
                    <div className="w-20 h-20 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center">
                      <svg
                        className="w-10 h-10 text-primary/60"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                        />
                      </svg>
                    </div>
                    <p className="text-muted-foreground text-sm font-medium">
                      {isRtl ? 'صورة البانر' : 'Hero Image'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Subtle glow behind image */}
            <div className="absolute -inset-4 -z-10 bg-primary/5 rounded-3xl blur-3xl" />
          </div>
        </div>
      </div>
    </section>
  );
}
