'use client';

import type { CategoryGridProps, CategoryStripProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import DahabCategoryCard from './CategoryCard';
import { DAHAB_CONTAINER, DahabSectionHeading, cx, pick } from './ui';

const COLS: Record<number, string> = {
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
};

export default function DahabCategoryGrid({
  categories,
  isRtl: isRtlProp,
  title,
  titleAr,
  subtitle,
  subtitleAr,
  desktopColumns = 4,
  urlPrefix = '',
  seeAllHref,
}: CategoryGridProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  if (categories.length === 0) return null;
  return (
    <div className={DAHAB_CONTAINER}>
      <DahabSectionHeading
        title={pick(isRtl, title, titleAr)}
        subtitle={pick(isRtl, subtitle, subtitleAr) || undefined}
        actionLabel={seeAllHref ? t('All collections', 'كل المجموعات') : undefined}
        actionHref={seeAllHref}
      />
      <div
        className={cx(
          'grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 md:grid-cols-3',
          COLS[desktopColumns] ?? COLS[4]
        )}
      >
        {categories.map(c => (
          <DahabCategoryCard key={c.id} category={c} isRtl={isRtl} urlPrefix={urlPrefix} />
        ))}
      </div>
    </div>
  );
}

/** Scrolling row of the same tiles (the "horizontal" categories layout). */
export function DahabCategoryStrip({
  categories,
  isRtl: isRtlProp,
  title,
  titleAr,
  urlPrefix = '',
  seeAllHref,
}: CategoryStripProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  if (categories.length === 0) return null;
  return (
    <div className={DAHAB_CONTAINER}>
      <DahabSectionHeading
        title={pick(isRtl, title, titleAr)}
        actionLabel={seeAllHref ? t('All collections', 'كل المجموعات') : undefined}
        actionHref={seeAllHref}
      />
      <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
        {categories.map(c => (
          <div key={c.id} className="w-[38%] shrink-0 snap-start sm:w-[24%] lg:w-[18%]">
            <DahabCategoryCard category={c} isRtl={isRtl} urlPrefix={urlPrefix} />
          </div>
        ))}
      </div>
    </div>
  );
}
