'use client';

import Link from 'next/link';
import Image from 'next/image';
import { sanitizeUrl } from '@force/shared';
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

  // No hardcoded marketing copy — fallback is empty so the merchant's own
  // values render unchanged when set, and nothing renders when not.
  const displayTitle = (isRtl && titleAr ? titleAr : title) ?? '';
  const displaySubtitle = (isRtl && subtitleAr ? subtitleAr : subtitle) ?? '';
  // CTA text falls back to a functional generic ("Shop Now") because it's
  // a button label, not content; without it the button has no text.
  const displayCta = isRtl && ctaTextAr ? ctaTextAr : ctaText || (isRtl ? 'تسوق الآن' : 'Shop Now');
  // Defensive XSS guard: reject `javascript:`/`data:` schemes before the link
  // reaches an `<a href>`.
  const safeCtaLink = sanitizeUrl(ctaLink, '/products');

  // When no image is configured, render a single-column centered hero
  // with a subtle radial gradient. This keeps the hero polished for stores
  // that haven't uploaded a slide image yet — the broken-looking placeholder
  // SVG box has been removed in favour of intentional whitespace.
  if (!image) {
    return (
      <section className="relative overflow-hidden bg-gradient-to-b from-primary/5 via-background to-background">
        <div
          className="container mx-auto px-4 py-20 sm:py-24 lg:py-32 xl:py-36"
          dir={isRtl ? 'rtl' : 'ltr'}
        >
          <div className="mx-auto max-w-3xl text-center motion-safe:[animation:heroFadeIn_0.7s_ease-out_both] motion-reduce:opacity-100">
            <h1
              className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold leading-[1.05] tracking-tight"
              style={{ letterSpacing: '-0.02em' }}
            >
              <span className="bg-gradient-to-r from-primary via-primary/80 to-primary/60 bg-clip-text text-transparent">
                {displayTitle}
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg md:text-xl text-muted-foreground leading-relaxed">
              {displaySubtitle}
            </p>
            <div className="mt-10 flex justify-center">
              <Link
                href={safeCtaLink}
                className="group inline-flex min-h-[44px] items-center gap-2.5 px-8 py-4 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 font-semibold text-base shadow-[0_18px_40px_-18px_hsl(var(--primary)/0.45)] transition-all duration-500 ease-out hover:shadow-[0_22px_48px_-18px_hsl(var(--primary)/0.55)] hover:-translate-y-0.5"
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
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden bg-background">
      <div className="container mx-auto px-4">
        <div
          className={`grid lg:grid-cols-2 gap-8 lg:gap-14 items-center min-h-[44vh] sm:min-h-[560px] py-12 sm:py-20 lg:py-28 ${isRtl ? 'direction-rtl' : ''}`}
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
                href={safeCtaLink}
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
              <Image
                src={image}
                alt={displayTitle}
                fill
                sizes="(min-width: 1024px) 50vw, 100vw"
                className="object-cover"
                priority
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent" />
            </div>

            {/* Subtle glow behind image */}
            <div className="absolute -inset-4 -z-10 bg-primary/5 rounded-3xl blur-3xl" />
          </div>
        </div>
      </div>
    </section>
  );
}
