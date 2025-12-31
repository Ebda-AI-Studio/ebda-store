'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';

export default function ElegantCategoryCard({ category, isRtl = false }: CategoryCardProps) {
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link
      href={`/products?category=${category.slug}`}
      className="group block"
    >
      {/* Image container with elegant aspect ratio */}
      <div className="relative aspect-[2/3] overflow-hidden bg-muted mb-6">
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center">
            <svg className="w-16 h-16 text-muted-foreground/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-foreground/0 group-hover:bg-foreground/10 transition-colors duration-500" />

        {/* View button that appears on hover */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <span className="px-6 py-3 bg-background text-foreground text-xs tracking-[0.2em] uppercase">
            {isRtl ? 'عرض' : 'View'}
          </span>
        </div>
      </div>

      {/* Title - Refined typography */}
      <div className={`text-center ${isRtl ? 'text-right' : 'text-left'}`}>
        <h3 className="text-base font-light text-foreground tracking-wide group-hover:text-primary transition-colors">
          {displayName}
        </h3>
        {category.productCount !== undefined && (
          <p className="text-xs text-muted-foreground mt-2 tracking-wider">
            {category.productCount} {isRtl ? 'قطعة' : 'pieces'}
          </p>
        )}
      </div>
    </Link>
  );
}
