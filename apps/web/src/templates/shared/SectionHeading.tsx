'use client';

import type React from 'react';
import Link from 'next/link';
import type { TemplateId } from '@force/shared';
import { getPackStyles } from './pack-styles';
import type { ResolvedZone } from './section-typography';
import { responsiveFontSize } from './section-typography';

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
  /**
   * Flanking hairlines around the kicker text. Default true preserves the
   * editorial divider look; set false to keep the kicker text alone.
   */
  showKickerLines?: boolean;
  /**
   * Flanking hairlines around the subtitle text. Default true preserves the
   * editorial divider look; set false to keep the subtitle text alone.
   */
  showSubtitleLines?: boolean;
  /**
   * Per-section typography overrides resolved by resolveSectionZone().
   * When provided, applied as inline styles on the heading h2, kicker span,
   * and subtitle wrapper. The auto-fix cascade rule in globals.css uses
   * !important on --section-fg so auto-picked contrast color wins over the
   * color field here when the section has an explicit bgColor.
   */
  headingZone?: ResolvedZone;
  kickerZone?: ResolvedZone;
  subtitleZone?: ResolvedZone;
  /** Typography override for the "See all →" link at the row end. */
  seeAllZone?: ResolvedZone;
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
  showKickerLines = true,
  showSubtitleLines = true,
  headingZone,
  kickerZone,
  subtitleZone,
  seeAllZone,
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
  //
  // Per-zone textAlign (start/center/end) overrides the default center on each
  // text element independently. When kicker/subtitle alignment is non-center,
  // the flanking editorial-divider hairlines auto-suppress because they only
  // read well on a centered line. Wrapper uses items-stretch so each child
  // takes the full row width and self-aligns via its own textAlign.
  const kickerAlign = kickerZone?.textAlign ?? 'center';
  const titleAlign = headingZone?.textAlign ?? 'center';
  const subtitleAlign = subtitleZone?.textAlign ?? 'center';
  const kickerShowLines = showKickerLines && kickerAlign === 'center';
  const subtitleShowLines = showSubtitleLines && subtitleAlign === 'center';
  return (
    <div className="mb-8 flex flex-col gap-2 sm:mb-12 sm:gap-3">
      {/* relative row: title-block is full-width-centered, seeAll absolute-anchored
          on the end edge. Mobile-first — on narrow viewports seeAll drops below
          the heading block instead of overlapping the centered title. */}
      <div className="relative">
        <div className="flex flex-col items-stretch gap-1.5 sm:gap-2">
          {kickerText && (
            // Editorial section divider — two hairline rules flanking the
            // kicker text (Ahmad 2026-05-17). The flanking lines can be
            // suppressed per-section via `showKickerLines={false}` (admin
            // toggle wires to `layout.<section>.showKickerLines`). When a
            // merchant explicitly sets chip styling on the sectionKicker
            // zone (backgroundColor / padding / borderRadius), the
            // typography emitter in apps/web/src/app/layout.tsx ALSO
            // pairs the chip rule with `[data-kicker-divider-line]{display:none}`
            // so the chip-style escape hatch still works.
            <div
              className={`self-stretch flex items-center gap-3 sm:gap-4 ${
                kickerAlign === 'start'
                  ? 'justify-start'
                  : kickerAlign === 'end'
                    ? 'justify-end'
                    : 'justify-center'
              }`}
            >
              {kickerShowLines && (
                <span
                  aria-hidden
                  data-kicker-divider-line
                  className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
                />
              )}
              <span
                className="text-base font-semibold uppercase tracking-[0.18em] text-foreground/70"
                data-zone="sectionKicker"
                style={{
                  fontFamily: kickerZone?.fontFamily,
                  fontSize: responsiveFontSize(kickerZone?.fontSize),
                  fontWeight: kickerZone?.fontWeight,
                  color: kickerZone?.color,
                  letterSpacing: kickerZone?.letterSpacing,
                  lineHeight: kickerZone?.lineHeight,
                  textTransform: kickerZone?.textTransform as React.CSSProperties['textTransform'],
                }}
              >
                {kickerText}
              </span>
              {kickerShowLines && (
                <span
                  aria-hidden
                  data-kicker-divider-line
                  className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
                />
              )}
            </div>
          )}
          {text && (
            <h2
              className={`${styles.sectionHeading} ${
                titleAlign === 'start'
                  ? 'text-start'
                  : titleAlign === 'end'
                    ? 'text-end'
                    : 'text-center'
              }`}
              data-zone="sectionTitle"
              style={{
                fontFamily: headingZone?.fontFamily,
                fontSize: responsiveFontSize(headingZone?.fontSize),
                fontWeight: headingZone?.fontWeight,
                color: headingZone?.color,
                letterSpacing: headingZone?.letterSpacing,
                lineHeight: headingZone?.lineHeight,
                textTransform: headingZone?.textTransform as React.CSSProperties['textTransform'],
              }}
            >
              {text}
            </h2>
          )}
          {subtitleText && (
            // Subtitle renders with flanking hairlines matching the
            // SectionKicker editorial-divider style (Ahmad 2026-05-17
            // evening — was manually typing "--- text ---" to fake it).
            // Lines suppressible per-section via `showSubtitleLines={false}`.
            // Long descriptive subtitles still look fine with the lines
            // — they extend `flex-1` to fill but cap at max-w so they
            // never dominate. Same `bg-foreground/30` opacity as the
            // kicker hairlines for visual consistency.
            <div
              className={`self-stretch flex items-center gap-3 sm:gap-4 ${
                subtitleAlign === 'start'
                  ? 'justify-start'
                  : subtitleAlign === 'end'
                    ? 'justify-end'
                    : 'justify-center'
              }`}
              data-zone="sectionSubtitle"
              style={{
                fontFamily: subtitleZone?.fontFamily,
                fontSize: responsiveFontSize(subtitleZone?.fontSize),
                fontWeight: subtitleZone?.fontWeight,
                color: subtitleZone?.color,
                letterSpacing: subtitleZone?.letterSpacing,
                lineHeight: subtitleZone?.lineHeight,
                textTransform: subtitleZone?.textTransform as React.CSSProperties['textTransform'],
              }}
            >
              {subtitleShowLines && (
                <span
                  aria-hidden
                  data-subtitle-divider-line
                  className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
                />
              )}
              <p className="text-xl text-muted-foreground max-w-2xl">{subtitleText}</p>
              {subtitleShowLines && (
                <span
                  aria-hidden
                  data-subtitle-divider-line
                  className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
                />
              )}
            </div>
          )}
        </div>
        {seeAllHref && (
          <Link
            href={seeAllHref}
            className={`mt-2 block text-end shrink-0 sm:absolute sm:end-0 sm:bottom-0 sm:mt-0 ${styles.sectionSeeAll}`}
            data-zone="sectionSeeAll"
            style={{
              fontFamily: seeAllZone?.fontFamily,
              fontSize: responsiveFontSize(seeAllZone?.fontSize),
              fontWeight: seeAllZone?.fontWeight,
              color: seeAllZone?.color,
              letterSpacing: seeAllZone?.letterSpacing,
              lineHeight: seeAllZone?.lineHeight,
              textTransform: seeAllZone?.textTransform as React.CSSProperties['textTransform'],
            }}
          >
            {isRtl ? 'عرض الكل' : 'See all'}
          </Link>
        )}
      </div>
    </div>
  );
}
