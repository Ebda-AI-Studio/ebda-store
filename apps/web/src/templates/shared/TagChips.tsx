'use client';
import Link from '../../components/StoreLink';
import type { PublicTag } from '../../lib/api';
import { tagLabel } from '../../lib/tag-label';

/**
 * Tag chips (`category-grid` with `source: 'tags'`, Phase B3, Jasmine; Ruling B3-5): the skin-type
 * / concern row ("حسب نوع بشرتك"). Text only, one horizontal scroll row with snap, 44px targets,
 * logical spacing and NO horizontal padding of its own beyond 4px for the focus ring (the section
 * container pads it, so the row starts exactly under the heading; RTL-safe: the flex row starts at the inline-start edge). Each chip links to the
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
      <ul className="-mx-1 flex snap-x scroll-px-1 gap-2 overflow-x-auto px-1 py-4 [scrollbar-width:none]">
        {tags.map(tg => {
          const l = tagLabel(tg, isRtl ? 'ar' : 'en');
          return (
            <li key={tg.id} className="shrink-0 snap-start">
              <Link
                href={`${urlPrefix}/products?tag=${encodeURIComponent(tg.name)}`}
                prefetch={false}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius)] border border-input px-4 text-sm text-foreground hover:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span lang={l.lang}>{l.text}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
