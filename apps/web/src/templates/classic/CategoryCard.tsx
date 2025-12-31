'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';

export default function ClassicCategoryCard({ category, isRtl = false }: CategoryCardProps) {
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link href={`/products?category=${category.slug}`} className="group block text-center">
      {/* Image with elegant border */}
      <div className="relative aspect-[3/4] mb-6 overflow-hidden border border-border/50 bg-muted">
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg
              className="w-16 h-16 text-muted-foreground/30"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
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
