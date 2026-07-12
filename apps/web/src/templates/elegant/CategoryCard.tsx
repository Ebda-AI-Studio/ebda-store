'use client';

import type React from 'react';
import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { categorySizeClass, cardShapeClasses } from '../shared/card-size';
import { responsiveFontSize } from '../shared/section-typography';
import { getCategoryCountUnit } from '../../lib/category-count-unit';

export default function ElegantCategoryCard({
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
  const { store } = useStore();
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;
  const countUnit = getCategoryCountUnit(store.theme, isRtl);
  const isOverlay = captionPosition === 'overlay';
  // Named shape overrides elegant's default aspect-square sm:aspect-[2/3]
  // + rounded-md (added 2026-05-16). Falls back to elegant defaults.
  const shape = cardShapeClasses(cardShape);
  const aspectClass = shape.aspect || 'aspect-square sm:aspect-[2/3]';
  const radiusClass = shape.radius || 'rounded-md';

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      prefetch={false}
      className={`group block outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 cursor-pointer w-full mx-auto ${categorySizeClass(cardSize)}`}
    >
      {/* Image container with elegant aspect ratio.
          Mobile-tame: aspect-square (1:1) on phones so a 2-col grid of
          categories doesn't blow past a screen height each. Original
          tall 2/3 ratio kept on sm+ where there's room. */}
      <div
        className={`relative ${aspectClass} overflow-hidden ${radiusClass} bg-muted shimmer mb-3`}
      >
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-700 ease-out"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-3xl font-light text-primary/60 tracking-wide">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-foreground/0 group-hover:bg-foreground/10 transition-colors duration-500" />

        {/* View button that appears on hover */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-700">
          <span className="px-7 py-3 bg-background/95 backdrop-blur-sm text-foreground text-[11px] tracking-[0.32em] uppercase font-medium">
            {isRtl ? 'عرض' : 'View'}
          </span>
        </div>

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

      {/* Title — always centered. Caption text reads cleanly under a
          centered category card regardless of language direction; mixing
          text-center with RTL/LTR aligns to a side which fights the
          centered image above. */}
      {!isOverlay && (
        <div className="text-center">
          <h3
            className="text-base font-light text-foreground tracking-[-0.005em] group-hover:text-foreground/70 transition-colors duration-700"
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
          {category.productCount !== undefined && (
            <p className="text-[11px] text-muted-foreground/80 mt-2 tracking-[0.22em] uppercase">
              {category.productCount} {countUnit}
            </p>
          )}
        </div>
      )}
    </Link>
  );
}
