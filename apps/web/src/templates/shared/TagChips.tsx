'use client';
import Link from 'next/link';
import type { PublicTag } from '../../lib/api';

/**
 * Tag chips (`category-grid` with `source: 'tags'`, Phase B3, Jasmine; Ruling B3-5): the skin-type
 * / concern row ("حسب نوع بشرتك"). Text only, one horizontal scroll row with snap, 44px targets,
 * logical spacing (RTL-safe: the flex row starts at the inline-start edge). Each chip links to the
 * PLP filtered by that tag (`/products?tag=<name>`).
 *
 * Only tags that carry at least one published product ever arrive here (`GET /public/tags`), so no
 * chip is a dead end; an empty list renders NOTHING.
 */
export function TagChips({
  tags,
  urlPrefix = '',
  isRtl,
  label,
}: {
  tags: readonly PublicTag[];
  urlPrefix?: string;
  isRtl: boolean;
  /** The nav's accessible name (the section heading, else a neutral default). */
  label?: string;
}) {
  if (!tags || tags.length === 0) return null;
  return (
    <nav aria-label={label || (isRtl ? 'الوسوم' : 'Tags')} data-section="tag-chips">
      <ul className="mx-auto flex max-w-7xl snap-x scroll-px-4 gap-2 overflow-x-auto px-4 py-4 sm:scroll-px-6 sm:px-6 lg:scroll-px-8 lg:px-8 [scrollbar-width:none]">
        {tags.map(tg => (
          <li key={tg.id} className="shrink-0 snap-start">
            <Link
              href={`${urlPrefix}/products?tag=${encodeURIComponent(tg.name)}`}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius)] border border-input px-4 text-sm text-foreground hover:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {tg.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
