'use client';

import CategoryCard from './CategoryCard';
import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { gridColsClass } from '../shared/card-size';

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
  mobileColumns,
  desktopColumns,
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

  // Honor the merchant's admin-picked desktop + mobile column counts.
  // Previously this used a count-based auto-size that ignored the admin
  // setting (Ahmad 2026-05-16: 'Categories do not follow the Desktop
  // columns number selected'). gridColsClass also caps mobile to
  // min(mobileColumns, categories.length) so a 1-cat store doesn't
  // try to render 4 cols.
  const cappedDesktop = (
    desktopColumns ? Math.min(desktopColumns, Math.max(1, categories.length)) : undefined
  ) as 2 | 3 | 4 | undefined;
  const cappedMobile = (
    mobileColumns ? Math.min(mobileColumns, Math.max(1, categories.length)) : undefined
  ) as 1 | 2 | 3 | undefined;

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
      <div className={`grid gap-3 md:gap-4 ${gridColsClass(cappedMobile, cappedDesktop)}`}>
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
