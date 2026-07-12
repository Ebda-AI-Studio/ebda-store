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
  if (categories.length === 0) {
    return null;
  }

  const cappedDesktop = (
    desktopColumns ? Math.min(desktopColumns, Math.max(1, categories.length)) : undefined
  ) as 2 | 3 | 4 | undefined;
  const cappedMobile = (
    mobileColumns ? Math.min(mobileColumns, Math.max(1, categories.length)) : undefined
  ) as 1 | 2 | 3 | undefined;

  // Item 2 (2026-07-12) persona-completion: classic's circular-tile identity
  // (design.md "jewelry-grid feel") only when personaChromeV2 is on AND the
  // merchant hasn't picked an explicit shape — reuses the existing
  // cardShapeClasses('circle') vocabulary, never a new shape. Merchant's
  // explicit pick always wins.
  const personaChromeV2 = store.theme?.personaChromeV2 === true;
  const effectiveCardShape =
    personaChromeV2 && (cardShape === undefined || cardShape === 'theme') ? 'circle' : cardShape;

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
          className={`grid ${gridGapClass(cardGap)} ${gridColsClass(cappedMobile, cappedDesktop)}`}
        >
          {categories.map((category, i) => {
            const frame = cardFrameClass(showCardFrame ?? true, cardFrameStyle);
            // Item 3 (2026-07-12): first-render stagger fade, 40ms step,
            // motion-safe only — no layout shift (opacity/transform only).
            const staggerCls =
              'motion-safe:[animation:fadeUp_0.5s_ease-out_calc(var(--i)*40ms)_both] motion-reduce:opacity-100';
            const staggerStyle = { ['--i' as string]: i } as React.CSSProperties;
            return frame ? (
              <div
                key={category.id}
                className={`${staggerCls} ${frame} ${cardFrameWidthClass(cardFrameWidth)} ${cardFrameSizeClass(cardFrameSize)} ${categorySizeClass(cardSize)} mx-auto w-full`}
                style={{
                  ...staggerStyle,
                  ...(store.theme
                    ? { borderColor: resolveColor(cardFrameColor ?? 'token:primary', store.theme) }
                    : undefined),
                }}
              >
                <CategoryCard
                  cardSize={cardSize}
                  cardAspect={cardAspect}
                  cardShape={effectiveCardShape}
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
              <div key={category.id} className={staggerCls} style={staggerStyle}>
                <CategoryCard
                  cardSize={cardSize}
                  cardAspect={cardAspect}
                  cardShape={effectiveCardShape}
                  captionPosition={captionPosition}
                  showLabel={showLabel}
                  showHover={showHover}
                  category={category}
                  isRtl={isRtl}
                  urlPrefix={urlPrefix}
                  categoryLabelZone={categoryLabelZone}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
