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
            // Editorial section divider — two hairline rules flanking the
            // kicker text (Ahmad 2026-05-17). Replaces the previous
            // `bg-primary/10 rounded-full` chip rendering. When a
            // merchant explicitly sets chip styling on the sectionKicker
            // zone (backgroundColor / padding / borderRadius), the
            // typography emitter in apps/web/src/app/layout.tsx pairs the
            // chip rule with `[data-kicker-divider-line]{display:none}`
            // so the chip comes back without the surrounding lines.
            <div className="self-stretch flex items-center justify-center gap-3 sm:gap-4">
              <span
                aria-hidden
                data-kicker-divider-line
                className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
              />
              <span
                className="text-base font-semibold uppercase tracking-[0.18em] text-foreground/70"
                data-zone="sectionKicker"
              >
                {kickerText}
              </span>
              <span
                aria-hidden
                data-kicker-divider-line
                className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
              />
            </div>
          )}
          {text && (
            <h2 className={styles.sectionHeading} data-zone="sectionTitle">
              {text}
            </h2>
          )}
          {subtitleText && (
            <p className="text-xl text-muted-foreground max-w-2xl" data-zone="sectionSubtitle">
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
