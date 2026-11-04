'use client';

import type React from 'react';
import Link from '../../components/StoreLink';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { categorySizeClass, cardShapeClasses } from '../shared/card-size';
import { responsiveFontSize } from '../shared/section-typography';
import { MissingImage } from '../shared/MissingImage';
import Image from 'next/image';
import { CATEGORY_TILE_SIZES } from '../../lib/image-sizes';

export default function MinimalCategoryCard({
  category,
  isRtl: isRtlProp,
  cardSize,
  cardShape,
  urlPrefix = '',
  categoryLabelZone,
  captionPosition,
}: CategoryCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;
  const isOverlay = captionPosition === 'overlay';
  // Named shape overrides minimal's default aspect-square sm:aspect-[4/3]
  // + rounded-md (added 2026-05-16). Falls back to minimal defaults.
  const shape = cardShapeClasses(cardShape);
  const aspectClass = shape.aspect || 'aspect-square sm:aspect-[4/3]';
  const radiusClass = shape.radius || 'rounded-md';

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      prefetch={false}
      className={`group block text-center outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 cursor-pointer w-full mx-auto ${categorySizeClass(cardSize)}`}
    >
      {/* Image — clean square with subtle rounding. Minimal identity
          keeps the radius small (`rounded-md`) so corners read crisp
          rather than soft. Named cardShape overrides both aspect + radius. */}
      <div className={`relative ${aspectClass} bg-muted/30 overflow-hidden ${radiusClass} mb-3`}>
        {category.image ? (
          <Image
            src={category.image}
            alt=""
            fill
            sizes={CATEGORY_TILE_SIZES}
            className="object-cover group-hover:opacity-85 transition-opacity duration-700 ease-out"
          />
        ) : (
          <MissingImage label={displayName} />
        )}

        {isOverlay && (
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

      {/* Title - Simple */}
      {!isOverlay && (
        <h3
          className="text-xs tracking-[0.22em] uppercase font-light text-muted-foreground group-hover:text-foreground transition-colors duration-500 ease-out"
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
        </h3>
      )}
    </Link>
  );
}
