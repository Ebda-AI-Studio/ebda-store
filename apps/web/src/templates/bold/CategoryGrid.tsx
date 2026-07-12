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
// wired through SectionTitleOverride actually apply. Pack='bold' picks
// font-black uppercase tracking-tight title from pack-styles. Bold persona
// suits HARD lines — defaults render hairlines + the brutalist staggered
// grid layout below (every other card translates down lg:translate-y-8).
export default function BoldCategoryGrid({
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

  return (
    <section
      className="relative overflow-hidden"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="categories"
    >
      {/* Background accent */}
      <div className="absolute top-0 left-0 w-1/2 h-1/2 bg-primary/5 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />

      <div className="container mx-auto px-4 relative z-10">
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
          pack="bold"
          seeAllHref={seeAllHref}
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
          seeAllZone={seeAllZone}
          sectionBgColor={sectionBgColor}
        />
        {/* Grid - Staggered layout for dynamism */}
        <div
          className={`grid ${gridGapClass(cardGap)} ${gridColsClass(cappedMobile, cappedDesktop)}`}
        >
          {categories.map((category, index) => {
            const stagger = index % 2 === 1 ? 'lg:translate-y-8' : '';
            const frame = cardFrameClass(showCardFrame ?? true, cardFrameStyle);
            // Item 3 (2026-07-12): first-render stagger FADE (distinct from
            // the `stagger` layout offset above), 40ms step, motion-safe
            // only — no layout shift (opacity/transform only).
            const enterStaggerCls =
              'motion-safe:[animation:fadeUp_0.5s_ease-out_calc(var(--i)*40ms)_both] motion-reduce:opacity-100';
            return (
              <div
                key={category.id}
                className={`${enterStaggerCls} ${stagger} ${frame} ${frame ? cardFrameWidthClass(cardFrameWidth) : ''} ${frame ? cardFrameSizeClass(cardFrameSize) : ''} ${frame ? `${categorySizeClass(cardSize)} mx-auto w-full` : ''}`.trim()}
                style={
                  {
                    ['--i' as string]: index,
                    ...(frame && store.theme
                      ? {
                          borderColor: resolveColor(cardFrameColor ?? 'token:primary', store.theme),
                        }
                      : undefined),
                  } as React.CSSProperties
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
            );
          })}
        </div>
      </div>
    </section>
  );
}
