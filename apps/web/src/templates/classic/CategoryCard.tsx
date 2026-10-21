'use client';

import type React from 'react';
import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { categorySizeClass, cardShapeClasses } from '../shared/card-size';
import { responsiveFontSize } from '../shared/section-typography';
import { categoryCountText } from '../../lib/category-count-unit';

export default function ClassicCategoryCard({
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
  const isOverlay = captionPosition === 'overlay';
  // Named shape overrides classic's default aspect-square sm:aspect-[3/4]
  // + rounded-sm (added 2026-05-16). Falls back to classic defaults.
  const shape = cardShapeClasses(cardShape);
  const aspectClass = shape.aspect || 'aspect-square sm:aspect-[3/4]';
  const radiusClass = shape.radius || 'rounded-sm';

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      prefetch={false}
      className={`group block text-center outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 cursor-pointer w-full mx-auto ${categorySizeClass(cardSize)}`}
    >
      {/* Image with elegant border + subtle rounded corners (classic
          keeps the smallest radius of the 5 themes — restraint is its
          identity, so rounded-sm rather than rounded-md or larger). */}
      <div
        className={`relative ${aspectClass} mb-3 overflow-hidden ${radiusClass} border border-border/60 bg-muted group-hover:border-foreground/35 transition-colors duration-700 ease-out`}
      >
        {category.image ? (
          <img
            src={category.image}
            alt=""
            className="w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-700 ease-out"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-muted flex items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-3xl font-light text-primary tracking-wide">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Subtle hover overlay */}
        <div className="absolute inset-0 bg-foreground/0 group-hover:bg-foreground/5 transition-colors duration-500" />

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

      {!isOverlay && (
        <>
          {/* Title - Serif typography */}
          <h3
            className="text-lg font-serif text-foreground group-hover:text-primary transition-colors duration-500 mb-2 tracking-tight"
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

          {/* Product count */}
          {category.productCount !== undefined && (
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              {categoryCountText(store.theme, isRtl, category.productCount)}
            </p>
          )}

          {/* Underline animation */}
          <div className="mt-4 flex justify-center">
            <div className="w-0 h-px bg-primary group-hover:w-12 transition-[width] duration-500" />
          </div>
        </>
      )}
    </Link>
  );
}
