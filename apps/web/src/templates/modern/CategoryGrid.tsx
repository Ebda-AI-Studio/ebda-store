'use client';

import CategoryCard from './CategoryCard';
import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor } from '@force/shared';
import { cardFrameClass, gridColsClass, gridGapClass } from '../shared/card-size';
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
        isRtl={isRtl}
        pack="modern"
      />
      <div
        className={`grid ${gridGapClass(cardGap)} ${gridColsClass(cappedMobile, cappedDesktop)}`}
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
  );
}
