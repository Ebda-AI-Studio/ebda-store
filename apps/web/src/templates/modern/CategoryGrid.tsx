'use client';

import CategoryCard from './CategoryCard';
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

export default function ModernCategoryGrid({
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

  // Honor the merchant's admin-picked desktop + mobile column counts.
  // Previously this used a count-based auto-size that ignored the admin
  // setting (Ahmad 2026-05-16). gridColsClass caps mobile to
  // min(mobileColumns, categories.length) so a 1-cat store doesn't try
  // to render 4 cols.
  const cappedDesktop = (
    desktopColumns ? Math.min(desktopColumns, Math.max(1, categories.length)) : undefined
  ) as 2 | 3 | 4 | undefined;
  const cappedMobile = (
    mobileColumns ? Math.min(mobileColumns, Math.max(1, categories.length)) : undefined
  ) as 1 | 2 | 3 | undefined;

  // 2026-05-17 night: heading rendering moved to the shared SectionHeading
  // so the editorial hairline toggles (showKickerLines / showSubtitleLines)
  // wired through SectionTitleOverride actually apply. Previously the
  // per-theme grid drew its own chip-style heading + the toggles were a
  // no-op here. Pack-styles supplies the per-theme h2 styling so the
  // title still looks modern; only kicker + subtitle chrome changes.
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} data-zone="categories">
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
        pack="modern"
        seeAllHref={seeAllHref}
        headingZone={headingZone}
        kickerZone={kickerZone}
        subtitleZone={subtitleZone}
        seeAllZone={seeAllZone}
        sectionBgColor={sectionBgColor}
      />
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
            <div key={category.id} className={staggerCls} style={staggerStyle}>
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
          );
        })}
      </div>
    </div>
  );
}
