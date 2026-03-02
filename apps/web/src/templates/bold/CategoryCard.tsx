'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';

export default function BoldCategoryCard({
  category,
  isRtl = false,
  urlPrefix = '',
}: CategoryCardProps) {
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link href={`${urlPrefix}/products?category=${category.slug}`} className="group block relative">
      {/* Card with dynamic hover */}
      <div className="relative aspect-[3/4] rounded-3xl overflow-hidden bg-primary shadow-xl transition-transform duration-300 group-hover:scale-[1.02] group-hover:-rotate-1">
        {/* Image */}
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-3xl font-black text-primary/60">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent" />

        {/* Content */}
        <div className="absolute inset-x-0 bottom-0 p-6">
          <h3 className="text-2xl font-black text-white mb-2 group-hover:text-primary transition-colors">
            {displayName}
          </h3>
          {category.productCount !== undefined && (
            <p className="text-white/70 font-bold">
              {category.productCount} {isRtl ? 'منتج' : 'items'}
            </p>
          )}
        </div>

        {/* Arrow */}
        <div
          className={`absolute top-4 ${isRtl ? 'left-4' : 'right-4'} w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-lg group-hover:bg-primary group-hover:text-white transition-all duration-300`}
        >
          <svg
            className={`w-6 h-6 ${isRtl ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={3}
              d="M13 7l5 5m0 0l-5 5m5-5H6"
            />
          </svg>
        </div>
      </div>
    </Link>
  );
}
