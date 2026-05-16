'use client';

import CategoryCard from './CategoryCard';
import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ModernCategoryGrid({
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
  showLabel,
  showHover,
  urlPrefix = '',
}: CategoryGridProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  if (categories.length === 0) {
    return null;
  }
  const displayTitle = isRtl ? (titleAr ?? title) : (title ?? titleAr);
  const displayKicker = isRtl ? (kickerAr ?? kicker) : (kicker ?? kickerAr);
  const displaySubtitle = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);

  // Auto-size grid based on category count for balanced layouts.
  // Bumped a second time 2026-05-16 per Ahmad: 'on desktop are huge must
  // be smaller'. xl breakpoint (1280px+) was too late — most desktops are
  // 1024-1440px wide, falling on lg or md. Now caps tile width earlier
  // at md:grid-cols-4 / lg:grid-cols-6 so 1024+ desktops show compact
  // ~150-180px tiles.
  const getGridCols = (count: number): string => {
    if (count === 1) return 'grid-cols-1';
    if (count === 2) return 'grid-cols-2';
    if (count === 3) return 'grid-cols-2 md:grid-cols-3';
    if (count === 4) return 'grid-cols-2 md:grid-cols-4';
    if (count === 5) return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-5';
    // 6+ categories: 2/4/6/6 cols across breakpoints — desktop cards
    // are ~170px wide at lg+ which matches the pecannbee reference
    // images ahmad shared.
    return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6';
  };

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} data-zone="categories">
      {(displayKicker || displayTitle || displaySubtitle) && (
        <div className="mb-8 sm:mb-12 flex flex-col items-center text-center gap-3">
          {displayKicker && (
            <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]">
              {displayKicker}
            </span>
          )}
          {displayTitle && (
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground tracking-tight">
              {displayTitle}
            </h2>
          )}
          {displaySubtitle && (
            <p className="text-sm md:text-base text-muted-foreground max-w-xl">{displaySubtitle}</p>
          )}
        </div>
      )}
      <div className={`grid gap-3 md:gap-4 ${getGridCols(categories.length)}`}>
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
  );
}
