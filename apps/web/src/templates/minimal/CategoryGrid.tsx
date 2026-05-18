'use client';

import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor } from '@force/shared';
import { cardFrameClass, gridColsClass, gridGapClass } from '../shared/card-size';
import { SectionHeading } from '../shared/SectionHeading';
import CategoryCard from './CategoryCard';

// 2026-05-17 night: heading rendering moved to the shared SectionHeading
// so the editorial hairline toggles (showKickerLines / showSubtitleLines)
// wired through SectionTitleOverride actually apply. Pack='minimal' picks
// font-extralight uppercase-tracked title from pack-styles. Note that
// minimal's persona is "silence" — merchants who want zero lines can set
// showKickerLines=false + showSubtitleLines=false in admin.
export default function MinimalCategoryGrid({
  categories,
  isRtl: isRtlProp,
  title,
  titleAr,
  kicker,
  kickerAr,
  subtitle,
  subtitleAr,
  showKickerLines,
  showSubtitleLines,
  cardSize,
  cardAspect,
  cardShape,
  cardGap,
  showLabel,
  showHover,
  showCardFrame,
  cardFrameStyle,
  cardFrameColor,
  mobileColumns,
  desktopColumns,
  urlPrefix = '',
  headingZone,
  kickerZone,
  subtitleZone,
}: CategoryGridProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store } = useStore();
  const isRtl = isRtlProp ?? ctxIsRtl;

  return (
    <section dir={isRtl ? 'rtl' : 'ltr'} data-zone="categories">
      <div className="container mx-auto px-4">
        <SectionHeading
          title={title}
          titleAr={titleAr}
          kicker={kicker}
          kickerAr={kickerAr}
          subtitle={subtitle}
          subtitleAr={subtitleAr}
          showKickerLines={showKickerLines}
          showSubtitleLines={showSubtitleLines}
          isRtl={isRtl}
          pack="minimal"
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
        />
        {/* Grid - Simple 4 columns */}
        <div
          className={`grid ${gridGapClass(cardGap)} ${gridColsClass(mobileColumns, desktopColumns)}`}
        >
          {categories.map(category => {
            const frame = cardFrameClass(showCardFrame, cardFrameStyle);
            return frame ? (
              <div
                key={category.id}
                className={frame}
                style={
                  cardFrameColor && store.theme
                    ? { borderColor: resolveColor(cardFrameColor, store.theme) }
                    : undefined
                }
              >
                <CategoryCard
                  cardSize={cardSize}
                  cardAspect={cardAspect}
                  cardShape={cardShape}
                  showLabel={showLabel}
                  showHover={showHover}
                  category={category}
                  isRtl={isRtl}
                  urlPrefix={urlPrefix}
                />
              </div>
            ) : (
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
            );
          })}
        </div>
      </div>
    </section>
  );
}
