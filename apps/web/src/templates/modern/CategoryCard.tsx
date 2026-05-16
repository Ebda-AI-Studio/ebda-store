'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { categorySizeClass, cardAspectClass } from '../shared/card-size';

/**
 * Modern category card — image + label-below layout. Per-store
 * cardSize / cardAspect / showLabel / showHover overrides allow
 * merchants to tune via the admin Layout page. Defaults: sm /
 * theme / show / show (Ahmad 2026-05-16 "smaller by default").
 */
export default function ModernCategoryCard({
  category,
  isRtl: isRtlProp,
  cardSize,
  cardAspect,
  showLabel = true,
  showHover = true,
  urlPrefix = '',
}: CategoryCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;
  const aspectOverride = cardAspectClass(cardAspect);
  // No aspect override → keep the modern theme's default: square on
  // mobile, landscape 4:3 on sm+ for a balanced grid feel.
  const aspectClass = aspectOverride || 'aspect-square sm:aspect-[4/3]';
  const hoverShadow = showHover
    ? 'group-hover:shadow-[0_12px_28px_-12px_hsl(var(--foreground)/0.18)]'
    : '';
  const hoverScale = showHover ? 'group-hover:scale-[1.03]' : '';

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      prefetch={false}
      className={`group block outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-xl w-full mx-auto ${categorySizeClass(cardSize)}`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div
        className={`relative ${aspectClass} rounded-xl overflow-hidden bg-muted shadow-[0_4px_12px_-6px_hsl(var(--foreground)/0.10)] ${hoverShadow} transition-shadow duration-500 ease-out`}
      >
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className={`absolute inset-0 w-full h-full object-cover ${hoverScale} transition-transform duration-500 ease-out`}
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-primary/8 to-muted" />
        )}
      </div>
      {showLabel && (
        <p className="mt-2 text-center text-sm md:text-base font-medium text-foreground line-clamp-1">
          {displayName}
        </p>
      )}
    </Link>
  );
}
