'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';

export default function MinimalCategoryCard({
  category,
  isRtl = false,
  urlPrefix = '',
}: CategoryCardProps) {
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link
      href={`${urlPrefix}/products?category=${category.slug}`}
      className="group block outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
    >
      {/* Image - Clean square */}
      <div className="aspect-square bg-gradient-to-br from-primary/10 to-primary/5 overflow-hidden mb-4">
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-500"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-2xl font-light text-primary/60">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Title - Simple */}
      <h3 className="text-sm font-normal text-foreground group-hover:text-primary transition-colors">
        {displayName}
      </h3>
    </Link>
  );
}
