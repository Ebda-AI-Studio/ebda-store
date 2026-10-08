'use client';

import type React from 'react';
import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { categorySizeClass, cardAspectClass, cardShapeClasses } from '../shared/card-size';
import { responsiveFontSize } from '../shared/section-typography';
import { ResponsiveImg } from '../../components/ResponsiveImg';

/**
 * Modern category card — image + label-below layout. Per-store
 * cardSize / cardAspect / cardShape / showLabel / showHover overrides
 * allow merchants to tune via the admin Layout page. Defaults: sm /
 * theme / theme / show / show (Ahmad 2026-05-16 "smaller by default").
 *
 * cardShape (when not 'theme') overrides BOTH cardAspect AND the
 * theme's default rounded-xl. cardAspect remains as a finer-grained
 * legacy control for merchants who only want to tweak aspect ratio.
 */
export default function ModernCategoryCard({
  category,
  isRtl: isRtlProp,
  cardSize,
  cardAspect,
  cardShape,
  showLabel = true,
  showHover = true,
  urlPrefix = '',
  categoryLabelZone,
  captionPosition,
}: CategoryCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;
  const isOverlay = captionPosition === 'overlay';
  const shape = cardShapeClasses(cardShape);
  const aspectOverride = shape.aspect || cardAspectClass(cardAspect);
  // No aspect override → keep the modern theme's default: square on
  // mobile, landscape 4:3 on sm+ for a balanced grid feel.
  const aspectClass = aspectOverride || 'aspect-square sm:aspect-[4/3]';
  // Named shape's radius wins; otherwise modern's default rounded-xl.
  const radiusClass = shape.radius || 'rounded-xl';
  const hoverShadow = showHover
    ? 'group-hover:shadow-[0_12px_28px_-12px_hsl(var(--foreground)/0.18)]'
    : '';
  const hoverScale = showHover ? 'group-hover:scale-[1.03]' : '';

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      prefetch={false}
      className={`group block outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${radiusClass} w-full mx-auto ${categorySizeClass(cardSize)}`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div
        className={`relative ${aspectClass} ${radiusClass} overflow-hidden bg-muted shadow-[0_4px_12px_-6px_hsl(var(--foreground)/0.10)] ${hoverShadow} transition-shadow duration-500 ease-out`}
      >
        {category.image ? (
          <ResponsiveImg
            src={category.image}
            sizes="(min-width: 1024px) 25vw, 50vw"
            alt={displayName}
            className={`absolute inset-0 w-full h-full object-cover ${hoverScale} transition-transform duration-500 ease-out`}
            loading="lazy"
          />
        ) : (
          // Two-stop on purpose (issue 2342): the old primary via-stop at opacity 8 was an
          // off-scale step that emitted nothing, so this is what always rendered.
          <div className="absolute inset-0 bg-gradient-to-br from-primary/15 to-muted" />
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
              {displayName}
            </h3>
          </div>
        )}
      </div>
      {!isOverlay && showLabel && (
        <p
          className="mt-2 text-center text-sm md:text-base font-medium text-foreground line-clamp-1"
          data-zone="categoryLabel"
          style={{
            fontFamily: categoryLabelZone?.fontFamily,
            fontSize: responsiveFontSize(categoryLabelZone?.fontSize),
            fontWeight: categoryLabelZone?.fontWeight,
            color: categoryLabelZone?.color,
            letterSpacing: categoryLabelZone?.letterSpacing,
            lineHeight: categoryLabelZone?.lineHeight,
            textTransform: categoryLabelZone?.textTransform as React.CSSProperties['textTransform'],
          }}
        >
          {displayName}
        </p>
      )}
    </Link>
  );
}
