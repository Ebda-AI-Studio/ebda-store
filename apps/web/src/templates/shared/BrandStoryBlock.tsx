'use client';

import { StoreAnchor } from '../../components/StoreLink';
import Image from 'next/image';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { sectionSpacingClasses } from './section-spacing';
import { sectionBgStyle } from './section-bg';
import type { SectionBgOverride, SectionPaddingMaxWidthVisibility } from '@ebda/shared';

/**
 * Bucket E (2026-05-17): inline editorial brand story block — image on
 * one side, body text on the other. Mobile stacks (image on top, text
 * below) per Stitch verification 2026-05-17 ("brand story reads
 * better with image-on-top stacked on mobile").
 *
 * Platform default uses `store.heroImage` as the editorial image and
 * `store.description` as the body copy. Returns null when neither is
 * present — no empty section, no chrome.
 *
 * Future per-merchant overrides will land via a dedicated admin
 * editor; today every store with a heroImage + description gets the
 * block automatically. Heading is platform default ("Our Story" /
 * "قصتنا") — translatable via admin if needed.
 */

interface BrandStoryBlockProps {
  image?: string | null;
  body?: string | null;
  bodyAr?: string | null;
  headingEn?: string;
  headingAr?: string;
  ctaHref?: string;
  ctaTextEn?: string;
  ctaTextAr?: string;
  /** Per-section spacing/visibility controls from page-builder. */
  spacingSettings?: SectionPaddingMaxWidthVisibility & SectionBgOverride;
}

export function BrandStoryBlock({
  image,
  body,
  bodyAr,
  headingEn = 'Our story',
  headingAr = 'قصتنا',
  ctaHref,
  ctaTextEn = 'Read More',
  ctaTextAr = 'اقرأ المزيد',
  spacingSettings,
}: BrandStoryBlockProps) {
  const { isRtl } = useLanguage();
  const { store } = useStore();
  const text = isRtl ? (bodyAr ?? body) : (body ?? bodyAr);
  if (!image && !text) return null;

  const { wrapperClass, innerContainerClass } = sectionSpacingClasses(spacingSettings, store.look);

  // Audit 2026-11-03 #6: a store with a description but no image got a 30 px heading and ONE 14 px
  // line floating in ~250 px of white. With no image the story is a designed band instead: the
  // sentence IS the content, set large and centred between two short rules on a soft tint, so a
  // thin store reads as editorial rather than empty. A long text stays a readable column.
  if (!image && text) {
    const short = text.length <= 160;
    return (
      <section
        aria-label={isRtl ? headingAr : headingEn}
        dir={isRtl ? 'rtl' : 'ltr'}
        data-story-band
        className={`bg-[hsl(var(--bg-page))] ${wrapperClass}`}
        style={sectionBgStyle(spacingSettings?.bgColor, store.theme)}
      >
        <div className={innerContainerClass}>
          <div className="mx-auto flex max-w-3xl flex-col items-center rounded-[var(--radius)] bg-foreground/[0.04] px-6 py-12 text-center sm:px-12 sm:py-16">
            <span aria-hidden="true" className="mb-5 h-px w-12 bg-foreground/30" />
            <h2 className="text-sm font-semibold text-foreground/70">
              {isRtl ? headingAr : headingEn}
            </h2>
            <p
              className={`mt-4 text-foreground ${
                short
                  ? 'text-2xl font-medium leading-snug sm:text-3xl'
                  : 'text-base leading-relaxed text-foreground/80 sm:text-lg'
              } ${short ? '' : 'line-clamp-6'}`}
            >
              {text}
            </p>
            {ctaHref && (
              <StoreAnchor
                href={ctaHref}
                className="mt-6 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-[hsl(var(--primary))] transition-colors hover:text-[hsl(var(--primary))]/80"
              >
                {isRtl ? ctaTextAr : ctaTextEn}
              </StoreAnchor>
            )}
            <span aria-hidden="true" className="mt-5 h-px w-12 bg-foreground/30" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label={isRtl ? headingAr : headingEn}
      dir={isRtl ? 'rtl' : 'ltr'}
      className={`bg-[hsl(var(--bg-page))] ${wrapperClass}`}
      style={sectionBgStyle(spacingSettings?.bgColor, store.theme)}
    >
      <div className={innerContainerClass}>
        <div className="grid grid-cols-1 gap-6 sm:gap-10 lg:grid-cols-2 lg:items-center">
          {image && (
            <div className="relative w-full aspect-[4/3] sm:aspect-[3/2] overflow-hidden rounded-lg bg-foreground/5">
              <Image
                src={image}
                alt={isRtl ? headingAr : headingEn}
                fill
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="object-cover"
                loading="lazy"
              />
            </div>
          )}
          <div className={image ? '' : 'lg:col-span-2 max-w-3xl mx-auto text-center'}>
            <h2 className="text-2xl sm:text-3xl font-bold text-foreground tracking-tight">
              {isRtl ? headingAr : headingEn}
            </h2>
            {text && (
              <p className="mt-4 text-base sm:text-lg text-foreground/75 leading-relaxed line-clamp-6">
                {text}
              </p>
            )}
            {ctaHref && (
              <StoreAnchor
                href={ctaHref}
                className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-[hsl(var(--primary))] hover:text-[hsl(var(--primary))]/80 transition-colors"
              >
                {isRtl ? ctaTextAr : ctaTextEn}
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={isRtl ? 'M10 19l-7-7m0 0l7-7m-7 7h18' : 'M14 5l7 7m0 0l-7 7m7-7H3'}
                  />
                </svg>
              </StoreAnchor>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
