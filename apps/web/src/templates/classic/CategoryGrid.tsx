'use client';

import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { gridColsClass, gridGapClass } from '../shared/card-size';
import { getDisplayTitle } from '../shared';
import CategoryCard from './CategoryCard';

export default function ClassicCategoryGrid({
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
    <section dir={isRtl ? 'rtl' : 'ltr'} data-zone="categories">
      <div className="container mx-auto px-4">
        {(displayKicker || displayTitle || displaySubtitle) && (
          <div className="text-center mb-10 md:mb-14 flex flex-col items-center gap-3">
            {displayKicker && (
              <span className="inline-flex items-center rounded-none bg-foreground text-background px-3 py-1 font-serif text-[10px] uppercase tracking-[0.3em]">
                {displayKicker}
              </span>
            )}
            <div className="w-12 h-px bg-border" />
            {displayTitle && (
              <h2 className="text-2xl md:text-3xl lg:text-4xl font-serif font-normal text-foreground">
                {displayTitle}
              </h2>
            )}
            {displaySubtitle && (
              <p className="font-serif text-sm md:text-base text-muted-foreground max-w-xl">
                {displaySubtitle}
              </p>
            )}
            <div className="w-12 h-px bg-border" />
          </div>
        )}

        {/* Grid - 4 columns on desktop for elegant spacing */}
        <div
          className={`grid ${gridGapClass(cardGap)} ${gridColsClass(mobileColumns, desktopColumns)}`}
        >
          {categories.map(category => (
            <CategoryCard
              cardSize={cardSize}
              cardAspect={cardAspect}
              showLabel={showLabel}
              showHover={showHover}
              key={category.id}
              category={category}
              isRtl={isRtl}
              urlPrefix={urlPrefix}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
