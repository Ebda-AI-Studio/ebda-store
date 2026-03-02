'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';

export default function ModernCategoryCard({
  category,
  isRtl = false,
  urlPrefix = '',
}: CategoryCardProps) {
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      className="group relative aspect-[4/3] rounded-xl overflow-hidden bg-muted"
    >
      {/* Image */}
      {category.image ? (
        <img
          src={category.image}
          alt={displayName}
          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
        />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="text-3xl font-semibold text-primary/60">
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        </div>
      )}

      {/* Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

      {/* Content */}
      <div className="absolute inset-0 flex flex-col justify-end p-4 md:p-6">
        <h3 className="text-lg md:text-xl font-bold text-white mb-1 group-hover:text-primary transition-colors">
          {displayName}
        </h3>
        {category.productCount !== undefined && (
          <p className="text-white/70 text-sm">
            {isRtl ? `${category.productCount} منتج` : `${category.productCount} products`}
          </p>
        )}

        {/* Arrow */}
        <div
          className={`absolute ${isRtl ? 'left-4' : 'right-4'} bottom-4 w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center group-hover:bg-primary transition-colors`}
        >
          <svg
            className={`w-5 h-5 text-white ${isRtl ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 8l4 4m0 0l-4 4m4-4H3"
            />
          </svg>
        </div>
      </div>
    </Link>
  );
}
