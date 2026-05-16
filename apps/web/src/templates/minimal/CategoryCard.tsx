'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { categorySizeClass } from '../shared/card-size';

export default function MinimalCategoryCard({
  category,
  isRtl: isRtlProp,
  cardSize,
  urlPrefix = '',
}: CategoryCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      prefetch={false}
      className={`group block text-center outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 cursor-pointer w-full mx-auto ${categorySizeClass(cardSize)}`}
    >
      {/* Image — clean square with subtle rounding. Minimal identity
          keeps the radius small (`rounded-md`) so corners read crisp
          rather than soft. Caption is left-of-card centered by parent. */}
      <div className="aspect-square sm:aspect-[4/3] bg-muted/30 overflow-hidden rounded-md mb-3">
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:opacity-85 transition-opacity duration-700 ease-out"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-muted/40">
            <div className="w-16 h-16 rounded-full bg-foreground/5 flex items-center justify-center">
              <span className="text-2xl font-light text-foreground/60 tracking-wide">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Title - Simple */}
      <h3 className="text-xs tracking-[0.22em] uppercase font-light text-muted-foreground group-hover:text-foreground transition-colors duration-500 ease-out">
        {displayName}
      </h3>
    </Link>
  );
}
