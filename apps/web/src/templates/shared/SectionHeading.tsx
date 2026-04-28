'use client';

import Link from 'next/link';
import type { TemplateId } from '@force/shared';
import { getPackStyles } from './pack-styles';

interface SectionHeadingProps {
  title?: string;
  titleAr?: string;
  isRtl?: boolean;
  /** When provided, renders a "see all" link at the end of the heading row. */
  seeAllHref?: string;
  pack?: TemplateId;
}

/**
 * Shared section heading row — used by category strip, product carousels,
 * and the testimonial row. Title at start, optional "see all" link at end.
 * Per-pack typography selected via `pack` (see pack-styles.ts).
 */
export function SectionHeading({ title, titleAr, isRtl, seeAllHref, pack }: SectionHeadingProps) {
  const text = isRtl ? (titleAr ?? title) : (title ?? titleAr);
  if (!text && !seeAllHref) return null;
  const styles = getPackStyles(pack);

  return (
    <div className="mb-10 flex items-end justify-between gap-4 sm:mb-14">
      {text && <h2 className={styles.sectionHeading}>{text}</h2>}
      {seeAllHref && (
        <Link href={seeAllHref} className={`shrink-0 ${styles.sectionSeeAll}`}>
          {isRtl ? 'عرض الكل' : 'See all'}
        </Link>
      )}
    </div>
  );
}
