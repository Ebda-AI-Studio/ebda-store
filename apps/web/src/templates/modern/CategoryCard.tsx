'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { ArrowIcon } from '../shared/icons';

export default function ModernCategoryCard({
  category,
  isRtl = false,
  urlPrefix = '',
}: CategoryCardProps) {
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      className="group relative aspect-[4/3] rounded-xl overflow-hidden bg-muted block cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
    >
      {/* Image */}
      {category.image ? (
        <img
          src={category.image}
          alt={displayName}
          className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ease-out"
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-primary/8 to-muted" />
      )}

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/25 to-black/5 group-hover:from-black/80 transition-colors duration-300" />

      {/* Content */}
      <div
        className={`absolute inset-0 flex flex-col justify-end p-4 md:p-5 ${isRtl ? 'items-end text-right' : 'items-start text-left'}`}
      >
        <div className="transform transition-transform duration-300 ease-out group-hover:-translate-y-1">
          <h3 className="text-base md:text-lg font-bold text-white leading-tight mb-0.5">
            {displayName}
          </h3>
          {category.productCount !== undefined && (
            <p className="text-white/90 text-xs font-medium">
              {isRtl ? `${category.productCount} منتج` : `${category.productCount} products`}
            </p>
          )}
        </div>
      </div>

      {/* Arrow button */}
      <div
        className={`absolute bottom-4 ${isRtl ? 'left-4' : 'right-4'} w-9 h-9 rounded-full bg-white/15 backdrop-blur-sm flex items-center justify-center group-hover:bg-primary group-hover:scale-110 transition-all duration-300`}
      >
        <ArrowIcon className="w-4 h-4 text-white" isRtl={isRtl} />
      </div>
    </Link>
  );
}
