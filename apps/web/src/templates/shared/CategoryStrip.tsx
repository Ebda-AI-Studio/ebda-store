'use client';

import { pickLocalizedName } from './display-helpers';
import type React from 'react';
import { useRef } from 'react';
import { ScrollArrows } from './ScrollArrows';
import Image from 'next/image';
import Link from 'next/link';
import { SectionHeading } from './SectionHeading';
import { getPackStyles } from './pack-styles';
import {
  cardAspectClass,
  cardFrameClass,
  cardFrameSizeClass,
  cardFrameWidthClass,
  cardShapeClasses,
  categorySizeClass,
  gridGapClass,
} from './card-size';
import type { CategoryStripProps } from '../types';
import { useStore } from '../../contexts/StoreContext';
import { getLook, resolveColor } from '@ebda/shared';
import { responsiveFontSize } from './section-typography';

/**
 * Horizontal-scroll category strip. Cards are square 1:1 images with
 * caption-below per Pecannbee. Frame + caption typography vary per pack:
 *   - Modern: rounded soft + sans-serif 600
 *   - Classic: sharp border + serif 700
 *   - Minimal: chrome-free + sans-serif 300
 *   - Bold: 2px border + black uppercase
 *   - Elegant: hairline + serif/light tracked
 */
export function CategoryStrip({
  categories,
  title,
  titleAr,
  kicker,
  kickerAr,
  subtitle,
  subtitleAr,
  showKickerLines,
  showSubtitleLines,
  seeAllHref,
  isRtl,
  urlPrefix = '',
  pack,
  cardSize,
  cardAspect,
  cardShape,
  cardGap,
  showLabel = true,
  showHover = true,
  showCardFrame,
  cardFrameStyle,
  cardFrameWidth,
  cardFrameSize,
  cardFrameColor,
  headingZone,
  kickerZone,
  subtitleZone,
  seeAllZone,
  categoryLabelZone,
  dividers,
  captionPosition,
  sectionBgColor,
}: CategoryStripProps) {
  // Hooks must be called unconditionally (before any early return).
  const { store } = useStore();
  const rowRef = useRef<HTMLUListElement>(null);
  const onLook = !!getLook(store?.look);
  const styles = getPackStyles(pack);
  const isOverlay = captionPosition === 'overlay';
  // Item 4 (2026-07-12): see ProductCarousel.tsx — suppresses the inner
  // pack-style frame when the outer showCardFrame is on AND the merchant
  // opted into frameChromeDedup. Default unchanged otherwise.
  const dedupInnerFrame = !!showCardFrame && store.theme?.frameChromeDedup === true;
  if (categories.length === 0) return null;
  const sizeCap = categorySizeClass(cardSize);
  const shape = cardShapeClasses(cardShape);
  const aspectCls = shape.aspect || cardAspectClass(cardAspect) || 'aspect-square';

  return (
    <section className="px-4 sm:px-6 lg:px-8" dir={isRtl ? 'rtl' : 'ltr'} data-zone="categories">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          title={title}
          titleAr={titleAr}
          kicker={kicker}
          kickerAr={kickerAr}
          subtitle={subtitle}
          subtitleAr={subtitleAr}
          showKickerLines={showKickerLines}
          showSubtitleLines={showSubtitleLines}
          dividers={dividers}
          isRtl={isRtl}
          seeAllHref={seeAllHref}
          pack={pack}
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
          seeAllZone={seeAllZone}
          // The strip's own band colour (W2a, LB-01): on a look store the heading contrasts with
          // the section it sits on, as the grid's already does, not with the page behind it.
          // Legacy stores keep their pinned markup (characterization); follow-up for them.
          sectionBgColor={onLook ? sectionBgColor : undefined}
        />
        {/* P2-13: prev/next for a mouse without a trackpad (same pair as ProductCarousel). */}
        <div className="relative">
          <ScrollArrows scrollRef={rowRef} isRtl={Boolean(isRtl)} />
          <ul
            ref={rowRef}
            // touch-pan-x + overscroll-x-contain: iOS-stuck-scroll fix
            // (same pattern as ProductCarousel) — see 2026-05-16 commit
            // for the snap-x/iOS direction-detect explanation.
            // `safe center` (quality bar L-05): a row that fits is centred instead of ending in an
            // empty tail; a row that overflows falls back to start, so scrolling is unchanged and a
            // row that already fills renders exactly as before.
            // scroll-ps-4 (LB-06, W2a, look stores): snapping the first tile keeps the 16px
            // inline-start gutter, so the row starts aligned with the heading and only the end peeks.
            className={`-mx-4 flex snap-x snap-mandatory ${onLook ? 'scroll-ps-4 ' : ''}${gridGapClass(cardGap)} overflow-x-auto overscroll-x-contain touch-pan-x px-4 pb-6 ${onLook ? 'justify-start' : '[justify-content:safe_center]'}`}
            style={{ scrollbarWidth: 'thin' }}
          >
            {categories.map((cat, i) => {
              const name = pickLocalizedName(cat, Boolean(isRtl)) ?? cat.name;
              const href = `${urlPrefix}/products?category=${cat.slug ?? cat.id}`;
              return (
                <li
                  key={cat.id}
                  // Item 3 (2026-07-12): first-render stagger fade, 40ms step,
                  // motion-safe only — no layout shift (opacity/transform only).
                  className={`snap-start shrink-0 w-[60vw] sm:w-[36vw] md:w-[30vw] lg:w-[26vw] xl:w-[22vw] ${sizeCap} ${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''} ${showCardFrame ? cardFrameSizeClass(cardFrameSize) : ''}`}
                  style={
                    {
                      ['--i' as string]: i,
                      ...(showCardFrame && cardFrameColor && store.theme
                        ? { borderColor: resolveColor(cardFrameColor, store.theme) }
                        : undefined),
                    } as React.CSSProperties
                  }
                >
                  <Link
                    href={href}
                    prefetch={false}
                    className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-2xl"
                  >
                    <div
                      className={`relative ${aspectCls} ${shape.radius} overflow-hidden ${showHover ? 'transition-transform duration-[var(--duration-slower)] ease-[var(--ease-out)] group-hover:scale-[1.015]' : ''} ${dedupInnerFrame ? '' : styles.categoryFrame}`}
                    >
                      {cat.image ? (
                        <Image
                          src={cat.image}
                          alt={showLabel === false ? (name ?? '') : ''}
                          fill
                          sizes="(max-width: 640px) 60vw, (max-width: 768px) 36vw, (max-width: 1024px) 30vw, (max-width: 1280px) 26vw, 400px"
                          className={`object-cover ${showHover ? 'transition-transform duration-[var(--duration-slower)] ease-[var(--ease-out)] group-hover:scale-[1.04]' : ''}`}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          <svg
                            className="h-12 w-12"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            aria-hidden
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"
                            />
                          </svg>
                        </div>
                      )}

                      {isOverlay && showLabel !== false && (
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent px-3 pb-3 pt-10 text-center">
                          <h3
                            className="text-white drop-shadow-sm line-clamp-1 text-sm sm:text-base font-semibold"
                            data-zone="categoryLabel"
                            style={{
                              fontFamily: categoryLabelZone?.fontFamily,
                              fontSize: responsiveFontSize(categoryLabelZone?.fontSize),
                              fontWeight: categoryLabelZone?.fontWeight,
                              color: categoryLabelZone?.color,
                              letterSpacing: categoryLabelZone?.letterSpacing,
                              lineHeight: categoryLabelZone?.lineHeight,
                              textTransform:
                                categoryLabelZone?.textTransform as React.CSSProperties['textTransform'],
                            }}
                          >
                            {name}
                          </h3>
                        </div>
                      )}
                    </div>
                    {!isOverlay && showLabel && (
                      <p
                        className={`mt-5 text-center line-clamp-2 ${styles.categoryCaption}`}
                        data-zone="categoryLabel"
                        style={{
                          fontFamily: categoryLabelZone?.fontFamily,
                          fontSize: responsiveFontSize(categoryLabelZone?.fontSize),
                          fontWeight: categoryLabelZone?.fontWeight,
                          color: categoryLabelZone?.color,
                          letterSpacing: categoryLabelZone?.letterSpacing,
                          lineHeight: categoryLabelZone?.lineHeight,
                          textTransform:
                            categoryLabelZone?.textTransform as React.CSSProperties['textTransform'],
                        }}
                      >
                        {name}
                      </p>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
