'use client';

import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { gridColsClass, gridGapClass } from '../shared/card-size';
import { getDisplayTitle } from '../shared';
import CategoryCard from './CategoryCard';

export default function ElegantCategoryGrid({
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
  cardShape,
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
        {/* Section header — kicker chip + title + subtitle. Inner py
            removed so HomePageContent's outer wrapper controls spacing
            and the section sits right under the hero (Ahmad 2026-05-16
            'close the white gap'). */}
        {(displayKicker || displayTitle || displaySubtitle) && (
          <div className="text-center mb-10 md:mb-14 flex flex-col items-center gap-3">
            {displayKicker && (
              <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-3 py-1 text-[10px] font-medium uppercase tracking-[0.3em]">
                {displayKicker}
              </span>
            )}
            {displayTitle && (
              <h2 className="text-3xl md:text-4xl font-light text-foreground tracking-wide">
                {displayTitle}
              </h2>
            )}
            {displaySubtitle && (
              <p className="text-sm md:text-base text-muted-foreground font-light max-w-xl">
                {displaySubtitle}
              </p>
            )}
          </div>
        )}

        {/* Grid - 3 columns for elegant spacing */}
        <div
          className={`grid ${gridGapClass(cardGap)} ${gridColsClass(mobileColumns, desktopColumns)}`}
        >
          {categories.map(category => (
            <CategoryCard
              cardSize={cardSize}
              cardAspect={cardAspect}
              cardShape={cardShape}
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
