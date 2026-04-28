'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { HeroProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function BoldHero({
  title,
  titleAr,
  subtitle,
  subtitleAr,
  image,
  ctaText,
  ctaTextAr,
  ctaLink = '/products',
  isRtl: isRtlProp,
  urlPrefix = '',
}: HeroProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  // No hardcoded "GO BOLD" marketing copy; merchant copy or nothing.
  const displayTitle = (isRtl && titleAr ? titleAr : title) ?? '';
  const displaySubtitle = (isRtl && subtitleAr ? subtitleAr : subtitle) ?? '';
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'تسوق الآن' : 'Shop Now');

  const resolvedCtaLink = ctaLink.startsWith('/') && urlPrefix ? `${urlPrefix}${ctaLink}` : ctaLink;

  return (
    <section
      className="relative min-h-[640px] sm:min-h-[720px] md:min-h-screen bg-gray-950 overflow-hidden"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {/* Full-screen hero image with dark overlay */}
      {image && (
        <div className="absolute inset-0">
          <Image
            src={image}
            alt={displayTitle}
            fill
            sizes="100vw"
            className="object-cover"
            priority
          />
          <div className="absolute inset-0 bg-gray-950/65" />
        </div>
      )}

      {/* Background pattern when no image */}
      {!image && (
        <div className="absolute inset-0 opacity-10">
          <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern
                id="bold-stripes"
                width="60"
                height="60"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line x1="0" y1="0" x2="0" y2="60" stroke="white" strokeWidth="20" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#bold-stripes)" />
          </svg>
        </div>
      )}

      {/* Content */}
      <div className="relative z-10 container mx-auto px-4 min-h-[640px] sm:min-h-[720px] md:min-h-screen flex flex-col justify-center py-16 sm:py-20 md:py-24">
        <div
          className={`max-w-3xl motion-reduce:animate-none ${isRtl ? 'mr-auto ml-0 text-right' : 'ml-0 text-left'}`}
          style={{ animation: 'boldSlideIn 0.6s ease-out both' }}
        >
          {/* "New Drop" pill removed — was hardcoded demo copy. If a
              merchant wants a tag/eyebrow above the headline they can
              add it via the AnnouncementBar instead. */}

          {/* Headline — scales down on mobile so 320–414px viewports don't overflow */}
          <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black uppercase tracking-tight text-white leading-[0.95] sm:leading-[0.9] mb-6 sm:mb-8 break-words">
            {displayTitle}
          </h1>

          {/* Subtitle */}
          <p className="text-base sm:text-lg md:text-xl text-white/60 font-medium max-w-lg mb-8 sm:mb-12 leading-relaxed">
            {displaySubtitle}
          </p>

          {/* CTA */}
          <Link
            href={resolvedCtaLink}
            className="inline-flex items-center gap-3 px-8 sm:px-10 py-4 sm:py-5 min-h-[44px] bg-primary text-primary-foreground rounded-none font-black text-sm sm:text-base uppercase tracking-[0.18em] hover:bg-primary/90 hover:scale-[1.02] transition-all duration-200 ease-out shadow-[0_18px_44px_-12px_hsl(var(--primary)/0.55)] cursor-pointer"
          >
            {displayCta}
            <svg
              className={`w-5 h-5 ${isRtl ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M13 7l5 5m0 0l-5 5m5-5H6"
              />
            </svg>
          </Link>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce motion-reduce:animate-none">
        <svg
          className="w-6 h-6 text-white/30"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 14l-7 7m0 0l-7-7m7 7V3"
          />
        </svg>
      </div>

      <style>{`
        @keyframes boldSlideIn {
          from { opacity: 0; transform: translateX(${isRtl ? '40px' : '-40px'}); }
          to { opacity: 1; transform: translateX(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .motion-reduce\\:animate-none { animation: none !important; }
        }
      `}</style>
    </section>
  );
}
