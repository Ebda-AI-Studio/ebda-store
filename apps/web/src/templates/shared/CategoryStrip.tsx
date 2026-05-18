'use client';

import Image from 'next/image';
import Link from 'next/link';
import { SectionHeading } from './SectionHeading';
import { getPackStyles } from './pack-styles';
import {
  cardAspectClass,
  cardFrameClass,
  cardShapeClasses,
  categorySizeClass,
  gridGapClass,
} from './card-size';
import type { CategoryStripProps } from '../types';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor } from '@force/shared';

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
  cardFrameColor,
  headingZone,
  kickerZone,
  subtitleZone,
}: CategoryStripProps) {
  // Hooks must be called unconditionally (before any early return).
  const { store } = useStore();
  const styles = getPackStyles(pack);
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
          isRtl={isRtl}
          seeAllHref={seeAllHref}
          pack={pack}
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
        />
        <ul
          // touch-pan-x + overscroll-x-contain: iOS-stuck-scroll fix
          // (same pattern as ProductCarousel) — see 2026-05-16 commit
          // for the snap-x/iOS direction-detect explanation.
          className={`-mx-4 flex snap-x snap-mandatory ${gridGapClass(cardGap)} overflow-x-auto overscroll-x-contain touch-pan-x px-4 pb-6`}
          style={{ scrollbarWidth: 'thin' }}
        >
          {categories.map(cat => {
            const name = isRtl ? (cat.nameAr ?? cat.name) : (cat.name ?? cat.nameAr);
            const href = `${urlPrefix}/products?category=${cat.slug ?? cat.id}`;
            return (
              <li
                key={cat.id}
                className={`snap-start shrink-0 w-[60vw] sm:w-[36vw] md:w-[30vw] lg:w-[26vw] xl:w-[22vw] ${sizeCap} ${cardFrameClass(showCardFrame, cardFrameStyle)}`}
                style={
                  showCardFrame && cardFrameColor && store.theme
                    ? { borderColor: resolveColor(cardFrameColor, store.theme) }
                    : undefined
                }
              >
                <Link
                  href={href}
                  prefetch={false}
                  className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 rounded-2xl"
                >
                  <div
                    className={`relative ${aspectCls} ${shape.radius} overflow-hidden ${showHover ? 'transition-transform duration-700 ease-out group-hover:scale-[1.015]' : ''} ${styles.categoryFrame}`}
                  >
                    {cat.image ? (
                      <Image
                        src={cat.image}
                        alt={name ?? ''}
                        fill
                        sizes="(max-width: 640px) 60vw, (max-width: 768px) 36vw, (max-width: 1024px) 30vw, (max-width: 1280px) 26vw, 400px"
                        className={`object-cover ${showHover ? 'transition-transform duration-700 ease-out group-hover:scale-[1.04]' : ''}`}
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
                  </div>
                  {showLabel && (
                    <p className={`mt-5 text-center line-clamp-2 ${styles.categoryCaption}`}>
                      {name}
                    </p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
