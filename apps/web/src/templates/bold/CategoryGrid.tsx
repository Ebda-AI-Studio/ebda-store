'use client';

import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { gridColsClass, gridGapClass } from '../shared/card-size';
import { getDisplayTitle } from '../shared';
import CategoryCard from './CategoryCard';

export default function BoldCategoryGrid({
  categories,
  isRtl: isRtlProp,
  title,
  titleAr,
  kicker,
  kickerAr,
  subtitle,
  subtitleAr,
  cardSize,
  cardAspect,
  cardGap,
  showLabel,
  showHover,
  mobileColumns,
  desktopColumns,
  urlPrefix = '',
}: CategoryGridProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayTitle = getDisplayTitle(isRtl, title, titleAr);
  const displayKicker = isRtl ? (kickerAr ?? kicker) : (kicker ?? kickerAr);
  const displaySubtitle = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);

  return (
    <section
      className="relative overflow-hidden"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="categories"
    >
      {/* Background accent */}
      <div className="absolute top-0 left-0 w-1/2 h-1/2 bg-primary/5 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />

      <div className="container mx-auto px-4 relative z-10">
        {(displayKicker || displayTitle || displaySubtitle) && (
          <div className="text-center mb-10 sm:mb-12 md:mb-14 flex flex-col items-center gap-3">
            {displayKicker && (
              <span className="inline-flex items-center bg-primary text-primary-foreground px-3 py-1 font-black text-xs uppercase tracking-[0.18em] rounded-none">
                {displayKicker}
              </span>
            )}
            {displayTitle && (
              <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black text-foreground tracking-tight">
                {displayTitle}
              </h2>
            )}
            {displaySubtitle && (
              <p className="text-sm md:text-base font-bold uppercase tracking-wider text-muted-foreground max-w-xl">
                {displaySubtitle}
              </p>
            )}
            <div className="mt-2 w-24 h-2 bg-primary rounded-full" />
          </div>
        )}

        {/* Grid - Staggered layout for dynamism */}
        <div
          className={`grid ${gridGapClass(cardGap)} ${gridColsClass(mobileColumns, desktopColumns)}`}
        >
          {categories.map((category, index) => (
            <div key={category.id} className={index % 2 === 1 ? 'lg:translate-y-8' : ''}>
              <CategoryCard
                cardSize={cardSize}
                cardAspect={cardAspect}
                showLabel={showLabel}
                showHover={showHover}
                category={category}
                isRtl={isRtl}
                urlPrefix={urlPrefix}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
