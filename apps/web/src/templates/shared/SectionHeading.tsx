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

  // IMPORTANT: data-zone tags are scoped to the SPECIFIC element each
  // typography zone targets — never the outer wrapper. Tagging the
  // wrapper makes the CSS rule `[data-zone="sectionTitle"] *` cascade
  // to the kicker chip, subtitle, AND seeAll link. Merchants who set
  // sectionTitle to a coloured pill or underline then saw the "View
  // all" link turn into a pill too (Ahmad 2026-05-16).
  //
  // Layout: kicker → title h2 → subtitle on the left, seeAll on the right.
  // Each text element gets its own data-zone so merchants can style them
  // independently from the Typography admin.
  return (
    <div className="mb-8 flex flex-col gap-2 sm:mb-12 sm:gap-3">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5 sm:gap-2">
          {kickerText && (
            <span
              className="self-start inline-flex items-center rounded-full bg-primary/10 text-primary px-3 py-1 text-base font-semibold uppercase tracking-[0.18em]"
              data-zone="sectionKicker"
            >
              {kickerText}
            </span>
          )}
          {text && (
            <h2 className={styles.sectionHeading} data-zone="sectionTitle">
              {text}
            </h2>
          )}
          {subtitleText && (
            <p className="text-base text-muted-foreground max-w-2xl" data-zone="sectionSubtitle">
              {subtitleText}
            </p>
          )}
        </div>
        {seeAllHref && (
          <Link
            href={seeAllHref}
            className={`shrink-0 ${styles.sectionSeeAll}`}
            data-zone="sectionSeeAll"
          >
            {isRtl ? 'عرض الكل' : 'See all'}
          </Link>
        )}
      </div>
    </div>
  );
}
