'use client';
import Link from '../../components/StoreLink';
import type { CategoryStripProps } from '../types';

/**
 * Category row as text chips (Ruling B1-2): the fastest first-screen path to a
 * category for stores whose photos carry the page (Qamar Atelier). Text only,
 * one horizontal scroll row with snap, 44px targets, logical spacing (RTL-safe:
 * the flex row starts at the inline-start edge, so Arabic scrolls from the right).
 *
 * `prefetch={false}` (Ruling PERF-PREFETCH-1): every chip is the same page with another query
 * string, so the default fetched one loading shell per category the moment the row came near the screen.
 */
export function CategoryChips({
  categories,
  urlPrefix = '',
  isRtl,
}: Pick<CategoryStripProps, 'categories' | 'urlPrefix' | 'isRtl'>) {
  if (!categories || categories.length === 0) return null;
  return (
    <nav aria-label={isRtl ? 'الأقسام' : 'Categories'} data-section="category-chips">
      <ul className="mx-auto flex max-w-7xl snap-x gap-2 overflow-x-auto px-4 py-4 sm:px-6 lg:px-8 [scrollbar-width:none]">
        {categories.map(c => (
          <li key={c.id} className="shrink-0 snap-start">
            <Link
              href={`${urlPrefix}/products?category=${encodeURIComponent(c.slug)}`}
              prefetch={false}
              className="inline-flex min-h-[44px] items-center rounded-[var(--radius)] border border-input px-4 text-sm text-foreground hover:border-foreground"
            >
              {isRtl ? c.nameAr || c.name : c.name || c.nameAr}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
