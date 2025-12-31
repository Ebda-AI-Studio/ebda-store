'use client';

import Link from 'next/link';
import type { HeroProps } from '../types';

export default function MinimalHero({
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
    isRtl && titleAr ? titleAr : title || (isRtl ? 'البساطة في التصميم' : 'Simply Beautiful');
  const displaySubtitle =
    isRtl && subtitleAr ? subtitleAr : subtitle || (isRtl ? 'أقل تعني أكثر' : 'Less is more');
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'تصفح' : 'Browse');

  return (
    <section className="min-h-[90vh] bg-background flex items-center" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        <div className="max-w-6xl mx-auto">
          {/* Content - Ultra minimal */}
          <div className="text-center mb-16">
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-light text-foreground tracking-tight leading-none mb-8">
              {displayTitle}
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground font-light max-w-md mx-auto mb-12">
              {displaySubtitle}
            </p>
            <Link
              href={ctaLink}
              className="inline-block text-sm tracking-[0.2em] uppercase text-foreground border-b border-foreground pb-1 hover:text-primary hover:border-primary transition-colors"
            >
              {displayCta}
            </Link>
          </div>

          {/* Image - Full width, clean */}
          <div className="aspect-[21/9] bg-muted overflow-hidden">
            {image ? (
              <img src={image} alt={displayTitle} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <span className="text-sm text-muted-foreground tracking-widest uppercase">
                  {isRtl ? 'صورة' : 'Image'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
