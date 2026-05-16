'use client';

import Link from 'next/link';
import type { TemplateId } from '@force/shared';
import { getPackStyles } from './pack-styles';

interface SectionHeadingProps {
  title?: string;
  titleAr?: string;
  /** Small uppercase eyebrow badge above the title (e.g. "EXPLORE"). */
  kicker?: string;
  kickerAr?: string;
  /** Tagline rendered below the title. */
  subtitle?: string;
  subtitleAr?: string;
  isRtl?: boolean;
  /** When provided, renders a "see all" link at the end of the heading row. */
  seeAllHref?: string;
  pack?: TemplateId;
}

/**
 * Shared section heading row — used by category strip, product carousels,
 * and the testimonial row. Title at start, optional kicker chip above + tagline
 * below, optional "see all" link at the end. Per-pack typography via `pack`.
 */
export function SectionHeading({
  title,
  titleAr,
  kicker,
  kickerAr,
  subtitle,
  subtitleAr,
  isRtl,
  seeAllHref,
  pack,
}: SectionHeadingProps) {
  const text = isRtl ? (titleAr ?? title) : (title ?? titleAr);
  const kickerText = isRtl ? (kickerAr ?? kicker) : (kicker ?? kickerAr);
  const subtitleText = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);
  if (!text && !seeAllHref && !kickerText && !subtitleText) return null;
  const styles = getPackStyles(pack);

  return (
    <div className="mb-8 flex flex-col gap-2 sm:mb-12 sm:gap-3" data-zone="sectionTitle">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5 sm:gap-2">
          {kickerText && (
            <span className="self-start inline-flex items-center rounded-full bg-primary/10 text-primary px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]">
              {kickerText}
            </span>
          )}
          {text && <h2 className={styles.sectionHeading}>{text}</h2>}
          {subtitleText && (
            <p className="text-sm text-muted-foreground sm:text-base max-w-2xl">{subtitleText}</p>
          )}
        </div>
        {seeAllHref && (
          <Link href={seeAllHref} className={`shrink-0 ${styles.sectionSeeAll}`}>
            {isRtl ? 'عرض الكل' : 'See all'}
          </Link>
        )}
      </div>
    </div>
  );
}
