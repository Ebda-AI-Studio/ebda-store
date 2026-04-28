'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { ArrowIcon } from '../shared/icons';

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
      className="group relative aspect-[4/3] rounded-2xl overflow-hidden bg-muted block cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 shadow-[0_10px_30px_-18px_hsl(var(--foreground)/0.15)] hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.20)] transition-shadow duration-700 ease-out"
    >
      {/* Image */}
      {category.image ? (
        <img
          src={category.image}
          alt={displayName}
          className="absolute inset-0 w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-700 ease-out"
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-primary/8 to-muted" />
      )}

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/15 to-transparent group-hover:from-black/75 transition-colors duration-500" />

      {/* Content */}
      <div
        className={`absolute inset-0 flex flex-col justify-end p-5 md:p-6 ${isRtl ? 'items-end text-right' : 'items-start text-left'}`}
      >
        <div className="transform transition-transform duration-500 ease-out group-hover:-translate-y-0.5">
          <h3 className="text-base md:text-lg font-bold text-white leading-tight tracking-tight mb-0.5">
            {displayName}
          </h3>
          {category.productCount !== undefined && (
            <p className="text-white/85 text-xs font-medium tracking-wide">
              {isRtl ? `${category.productCount} منتج` : `${category.productCount} products`}
            </p>
          )}
        </div>
      </div>

      {/* Arrow button */}
      <div
        className={`absolute bottom-5 ${isRtl ? 'left-5' : 'right-5'} w-10 h-10 rounded-full bg-white/15 backdrop-blur-sm flex items-center justify-center text-white group-hover:bg-white group-hover:text-foreground transition-all duration-500 ease-out`}
      >
        <ArrowIcon className="w-4 h-4" isRtl={isRtl} />
      </div>
    </Link>
  );
}
