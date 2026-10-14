'use client';

import Link from 'next/link';
import Image from 'next/image';
import { sanitizeUrl } from '@ebda/shared';
import type { HeroProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ElegantHero({
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
  // No hardcoded marketing strings — empty values render nothing instead
  // of competing with merchant copy.
  const displayTitle = (isRtl && titleAr ? titleAr : title) ?? '';
  const displaySubtitle = (isRtl && subtitleAr ? subtitleAr : subtitle) ?? '';
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'استكشف' : 'Discover');

  // Defensive XSS guard: reject `javascript:`/`data:` schemes before the link
  // reaches an `<a href>`. Safe values (relative paths, http(s)) pass through.
  const safeCtaLink = sanitizeUrl(ctaLink, '/products');
  const resolvedCtaLink =
    safeCtaLink.startsWith('/') && urlPrefix ? `${urlPrefix}${safeCtaLink}` : safeCtaLink;

  return (
    <section
      className="relative overflow-hidden motion-reduce:animate-none"
      dir={isRtl ? 'rtl' : 'ltr'}
      style={{ animation: 'elegantFadeIn 0.5s ease-out both' }}
    >
      {image ? (
        /* Asymmetric layout: image 60% + text 40%.
           Mobile heights tightened 2026-05-14: the previous min-h-[85vh] /
           min-h-[50vh] combination meant mobile visitors saw a stack where
           BOTH the image half and the text half could clear screen height,
           so they'd scroll a full extra viewport before seeing categories /
           products. Scaled the floors down for mobile + small tablets,
           kept the desktop 85vh feel via lg: variant. */
        <div className="flex flex-col lg:flex-row min-h-[60vh] sm:min-h-[75vh] lg:min-h-[85vh]">
          {/* Image side — 60%.
              bg-muted backdrop fills the letterbox on mobile when the
              merchant's banner is wider than the mobile aspect-[4/3]
              container — object-contain on phones keeps the full
              calligraphy / text design visible (Wady's "من الوادي
              إلى الأيادي" was getting cut on both sides at object-cover).
              At lg+ where the image area takes ~60vw, object-cover
              fills the larger surface without losing meaningful pixels. */}
          <div
            className={`relative w-full lg:w-[60%] aspect-[4/3] sm:aspect-[16/10] lg:aspect-auto lg:min-h-full bg-muted ${isRtl ? 'lg:order-2' : 'lg:order-1'} overflow-hidden`}
          >
            <Image
              src={image}
              alt={displayTitle}
              fill
              sizes="(min-width: 1024px) 60vw, 100vw"
              className="object-contain lg:object-cover"
              priority
            />
            <div className="absolute inset-0 bg-foreground/10" />
          </div>

          {/* Text side — 40% */}
          <div
            className={`w-full lg:w-[40%] bg-background flex items-center ${isRtl ? 'lg:order-1' : 'lg:order-2'}`}
          >
            <div
              className={`px-6 sm:px-8 md:px-12 lg:px-16 py-10 sm:py-12 md:py-16 max-w-lg ${isRtl ? 'text-right mr-auto' : 'text-left'}`}
            >
              {/* Eyebrow ("New Collection") removed — was hardcoded
                  template demo copy. */}
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-light text-foreground leading-[1.1] tracking-[-0.02em] mb-8 mt-10">
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
                data-cta="button"
                className="group inline-flex items-center gap-4 px-8 py-4 border border-foreground text-foreground text-sm tracking-[0.25em] uppercase font-medium hover:bg-foreground hover:text-background transition-colors duration-500 cursor-pointer"
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
            {/* Issue 2342: this ring carried a primary border at opacity 8, an off-scale step
                Tailwind 3 emits NO rule for, so it has always rendered with the
                base border colour. The dead class is removed (pixel-identical);
                a primary-tinted ring would be a visible storefront change. */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[450px] h-[450px] rounded-full border" />
          </div>

          <div className="relative z-10 container mx-auto px-4 py-28 md:py-36 lg:py-44">
            <div className="max-w-2xl mx-auto text-center">
              {/* Eyebrow removed — was hardcoded demo copy. */}
              <h1 className="text-5xl md:text-6xl lg:text-7xl font-light text-foreground leading-[1.1] tracking-[-0.02em] mb-8 mt-10">
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
                data-cta="button"
                className="group inline-flex items-center gap-4 px-10 py-4 border border-foreground text-foreground text-sm tracking-[0.25em] uppercase font-medium hover:bg-foreground hover:text-background transition-colors duration-500 cursor-pointer"
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

          {/* Bottom perks bar removed — these claims (free shipping, easy
              returns, white-glove service) aren't true for every tenant.
              Stores that want to advertise perks should use the configurable
              AnnouncementBar above the header. */}
        </div>
      )}

      <style>{`
        @keyframes elegantFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .motion-reduce\\:animate-none { animation: none !important; }
        }
      `}</style>
    </section>
  );
}
