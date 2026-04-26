'use client';

import Image from 'next/image';
import Link from 'next/link';
import { SectionHeading } from './SectionHeading';
import { getPackStyles } from './pack-styles';
import type { CategoryStripProps } from '../types';

/**
 * Horizontal-scroll category strip. Cards are square 1:1 images with
 * caption-below per Pecannbee. Frame + caption typography vary per pack:
 *   - Modern: rounded soft + sans-serif 600
 *   - Classic: sharp border + serif 700
 *   - Minimal: chrome-free + sans-serif 300
 *   - Bold: 2px border + black uppercase
 *   - Elegant: hairline + serif/light tracked
 */
export function CategoryStrip({
  categories,
  title,
  titleAr,
  seeAllHref,
  isRtl,
  urlPrefix = '',
  pack,
}: CategoryStripProps) {
  if (categories.length === 0) return null;
  const styles = getPackStyles(pack);

  return (
    <section className="px-4 sm:px-6 lg:px-8" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          title={title}
          titleAr={titleAr}
          isRtl={isRtl}
          seeAllHref={seeAllHref}
          pack={pack}
        />
        <ul
          className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:gap-6 lg:gap-8"
          style={{ scrollbarWidth: 'thin' }}
        >
          {categories.map(cat => {
            const name = isRtl ? (cat.nameAr ?? cat.name) : (cat.name ?? cat.nameAr);
            const href = `${urlPrefix}/products?category=${cat.slug ?? cat.id}`;
            return (
              <li
                key={cat.id}
                className="snap-start shrink-0 w-[40vw] sm:w-[28vw] lg:w-[18vw] max-w-[260px]"
              >
                <Link
                  href={href}
                  className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  <div className={`relative aspect-square overflow-hidden ${styles.categoryFrame}`}>
                    {cat.image ? (
                      <Image
                        src={cat.image}
                        alt={name ?? ''}
                        fill
                        sizes="(max-width: 640px) 40vw, (max-width: 1024px) 28vw, 18vw"
                        className="object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <svg
                          className="h-10 w-10"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          aria-hidden
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"
                          />
                        </svg>
                      </div>
                    )}
                  </div>
                  <p className={`mt-3 text-center line-clamp-2 ${styles.categoryCaption}`}>
                    {name}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
