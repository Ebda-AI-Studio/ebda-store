'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

/**
 * Modern category card — image + label-below layout matching the
 * pecannbee/alkahraman target sizing (see docs/superpowers/plans/
 * 2026-05-16-mobile-ui-ship.md). Previous version used a heavy dark
 * gradient overlay + arrow button + thick shadow that made tiles
 * read as premium feature cards rather than compact nav tiles.
 *
 * Now: square image at top (1:1 mobile, 4:3 desktop), plain text
 * label centered below. No overlay, no arrow, modest shadow. Tiles
 * feel like navigation, not editorial.
 */
export default function ModernCategoryCard({
  category,
  isRtl: isRtlProp,
  urlPrefix = '',
}: CategoryCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      prefetch={false}
      className="group block outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-xl"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="relative aspect-square sm:aspect-[4/3] rounded-xl overflow-hidden bg-muted shadow-[0_4px_12px_-6px_hsl(var(--foreground)/0.10)] group-hover:shadow-[0_12px_28px_-12px_hsl(var(--foreground)/0.18)] transition-shadow duration-500 ease-out">
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="absolute inset-0 w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500 ease-out"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-primary/8 to-muted" />
        )}
      </div>
      <p className="mt-2 text-center text-sm md:text-base font-medium text-foreground line-clamp-1">
        {displayName}
      </p>
    </Link>
  );
}
