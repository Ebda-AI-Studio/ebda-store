'use client';

import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor } from '@force/shared';
import {
  cardFrameClass,
  categorySizeClass,
  cardFrameSizeClass,
  cardFrameWidthClass,
  gridColsClass,
  gridGapClass,
} from '../shared/card-size';
import { SectionHeading } from '../shared/SectionHeading';
import CategoryCard from './CategoryCard';

// 2026-05-17 night: heading rendering moved to the shared SectionHeading
// so the editorial hairline toggles (showKickerLines / showSubtitleLines)
// wired through SectionTitleOverride actually apply. Pack='classic' picks
// serif title + serif tracked kicker styling from pack-styles.
export default function ClassicCategoryGrid({
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
  dividers,
  cardSize,
  cardAspect,
  cardShape,
  captionPosition,
  cardGap,
  showLabel,
  showHover,
  showCardFrame,
  cardFrameStyle,
  cardFrameWidth,
  cardFrameSize,
  cardFrameColor,
  mobileColumns,
  desktopColumns,
  urlPrefix = '',
  seeAllHref,
  headingZone,
  kickerZone,
  subtitleZone,
  seeAllZone,
  categoryLabelZone,
  sectionBgColor,
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
          dividers={dividers}
          isRtl={isRtl}
          pack="classic"
          seeAllHref={seeAllHref}
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
          seeAllZone={seeAllZone}
          sectionBgColor={sectionBgColor}
        />
        {/* Grid - 4 columns on desktop for elegant spacing */}
        <div
          className={`grid ${gridGapClass(cardGap)} ${gridColsClass(mobileColumns, desktopColumns)}`}
        >
          {categories.map(category => {
            const frame = cardFrameClass(showCardFrame ?? true, cardFrameStyle);
            return frame ? (
              <div
                key={category.id}
                className={`${frame} ${cardFrameWidthClass(cardFrameWidth)} ${cardFrameSizeClass(cardFrameSize)} ${categorySizeClass(cardSize)} mx-auto w-full`}
                style={
                  store.theme
                    ? { borderColor: resolveColor(cardFrameColor ?? 'token:primary', store.theme) }
                    : undefined
                }
              >
                <CategoryCard
                  cardSize={cardSize}
                  cardAspect={cardAspect}
                  cardShape={cardShape}
                  captionPosition={captionPosition}
                  showLabel={showLabel}
                  showHover={showHover}
                  category={category}
                  isRtl={isRtl}
                  urlPrefix={urlPrefix}
                  categoryLabelZone={categoryLabelZone}
                />
              </div>
            ) : (
              <CategoryCard
                cardSize={cardSize}
                cardAspect={cardAspect}
                cardShape={cardShape}
                captionPosition={captionPosition}
                showLabel={showLabel}
                showHover={showHover}
                key={category.id}
                category={category}
                isRtl={isRtl}
                urlPrefix={urlPrefix}
                categoryLabelZone={categoryLabelZone}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
