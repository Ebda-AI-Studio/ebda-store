'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';

export default function ClassicCategoryCard({
  category,
  isRtl = false,
  urlPrefix = '',
}: CategoryCardProps) {
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      className="group block text-center"
    >
      {/* Image with elegant border */}
      <div className="relative aspect-[3/4] mb-6 overflow-hidden border border-border/50 bg-muted">
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-3xl font-light text-primary/60 tracking-wide">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Subtle hover overlay */}
        <div className="absolute inset-0 bg-foreground/0 group-hover:bg-foreground/5 transition-colors duration-500" />
      </div>

      {/* Title - Serif typography */}
      <h3 className="text-lg font-serif text-foreground group-hover:text-primary transition-colors duration-300 mb-2">
        {displayName}
      </h3>

      {/* Product count */}
      {category.productCount !== undefined && (
        <p className="text-sm text-muted-foreground">
          {isRtl ? `${category.productCount} قطعة` : `${category.productCount} pieces`}
        </p>
      )}

      {/* Underline animation */}
      <div className="mt-4 flex justify-center">
        <div className="w-0 h-px bg-primary group-hover:w-12 transition-all duration-500" />
      </div>
    </Link>
  );
}
