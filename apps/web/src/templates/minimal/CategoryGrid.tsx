'use client';

import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getDisplayTitle } from '../shared';
import CategoryCard from './CategoryCard';

export default function MinimalCategoryGrid({
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
  const displayTitle = getDisplayTitle(isRtl, title, titleAr);
  const displayKicker = isRtl ? (kickerAr ?? kicker) : (kicker ?? kickerAr);
  const displaySubtitle = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);

  return (
    <section dir={isRtl ? 'rtl' : 'ltr'} data-zone="categories">
      <div className="container mx-auto px-4">
        {(displayKicker || displayTitle || displaySubtitle) && (
          <div className="mb-10 md:mb-12 flex flex-col items-center text-center gap-3">
            {displayKicker && (
              <span className="text-[10px] tracking-[0.3em] uppercase font-light text-foreground/60 border border-foreground/15 px-3 py-1">
                {displayKicker}
              </span>
            )}
            {displayTitle && (
              <h2 className="text-sm tracking-[0.2em] uppercase text-muted-foreground font-light">
                {displayTitle}
              </h2>
            )}
            {displaySubtitle && (
              <p className="text-[10px] tracking-[0.2em] uppercase font-light text-muted-foreground/70 max-w-xl">
                {displaySubtitle}
              </p>
            )}
          </div>
        )}

        {/* Grid - Simple 4 columns */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 md:gap-4">
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
