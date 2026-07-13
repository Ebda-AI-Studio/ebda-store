'use client';

import type React from 'react';
import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { categorySizeClass, cardShapeClasses } from '../shared/card-size';
import { responsiveFontSize } from '../shared/section-typography';
import { getCategoryCountUnit } from '../../lib/category-count-unit';

export default function BoldCategoryCard({
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
  // Named shape overrides bold's brutalist default aspect-square sm:aspect-[3/4]
  // + rounded-3xl. Falls back to bold defaults.
  const shape = cardShapeClasses(cardShape);
  const aspectClass = shape.aspect || 'aspect-square sm:aspect-[3/4]';
  const radiusClass = shape.radius || 'rounded-3xl';

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      prefetch={false}
      className={`group block relative outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 w-full mx-auto ${categorySizeClass(cardSize)}`}
    >
      {/* Card with dynamic hover. Aspect + radius come from cardShape
          when set, else bold's brutalist defaults. */}
      <div
        className={`relative ${aspectClass} ${radiusClass} overflow-hidden bg-primary shadow-[0_18px_44px_-18px_hsl(var(--foreground)/0.30)] transition-transform duration-300 ease-out group-hover:scale-[1.015] group-hover:-rotate-[0.5deg]`}
      >
        {/* Image */}
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-[1.06] transition-transform duration-700 ease-out"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-3xl font-black text-primary/60">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Gradient Overlay + Content — only in overlay mode */}
        {isOverlay && (
          <>
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-6">
              <h3
                className="text-2xl font-black uppercase text-white mb-2 tracking-tight group-hover:text-primary transition-colors duration-200"
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
                <p className="text-white/75 font-bold uppercase tracking-[0.05em] text-sm">
                  {category.productCount} {countUnit}
                </p>
              )}
            </div>
          </>
        )}

        {/* Arrow */}
        <div
          className={`absolute top-5 ${isRtl ? 'left-5' : 'right-5'} w-12 h-12 bg-white text-foreground rounded-2xl flex items-center justify-center shadow-[0_8px_22px_-8px_hsl(var(--foreground)/0.45)] group-hover:bg-primary group-hover:text-primary-foreground transition-colors duration-200`}
        >
          <svg
            className={`w-6 h-6 ${isRtl ? 'rotate-180' : ''}`}
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
        </div>
      </div>

      {/* Below-image label — only when NOT in overlay mode */}
      {!isOverlay && (
        <h3
          className="mt-3 text-center text-base font-black uppercase text-foreground tracking-tight"
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
