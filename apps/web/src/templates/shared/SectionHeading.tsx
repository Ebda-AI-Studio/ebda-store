'use client';

import type React from 'react';
import Link from 'next/link';
import type { TemplateId, SectionDividers } from '@force/shared';
import { getPackStyles } from './pack-styles';
import type { ResolvedZone } from './section-typography';
import { responsiveFontSize } from './section-typography';
import { SectionDivider } from './SectionDivider';

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
   * @deprecated 2026-05-20 — use `dividers.kicker.enabled` instead. Still read
   * as fallback when `dividers.kicker` is undefined.
   */
  showKickerLines?: boolean;
  /**
   * Flanking hairlines around the subtitle text. Default true preserves the
   * editorial divider look; set false to keep the subtitle text alone.
   * @deprecated 2026-05-20 — use `dividers.subtitle.enabled` instead. Still read
   * as fallback when `dividers.subtitle` is undefined.
   */
  showSubtitleLines?: boolean;
  /**
   * Per-section divider settings. When provided, `kicker.enabled` /
   * `title.enabled` / `subtitle.enabled` toggle flanking hairlines around
   * each text element. `belowHeading` (full DividerSettings) renders a
   * horizontal line between this heading block and the section content.
   *
   * The `above` slot is rendered by the parent (HomePageContent) BEFORE
   * the section, not by SectionHeading itself.
   */
  dividers?: SectionDividers;
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
  dividers,
}: SectionHeadingProps) {
  // Per-section dividers override the legacy showKickerLines / showSubtitleLines
  // booleans when present. When the new `dividers.{kicker,title,subtitle}` is
  // undefined, fall back to the deprecated boolean props so existing stores
  // keep their current look.
  const kickerLinesEnabled = dividers?.kicker?.enabled ?? showKickerLines !== false;
  const titleLinesEnabled = dividers?.title?.enabled === true;
  const subtitleLinesEnabled = dividers?.subtitle?.enabled ?? showSubtitleLines !== false;
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
  // Flanking hairlines only render when text alignment is center — they look
  // disjointed flanking left/right-aligned text. Combine the resolved-toggle
  // value (kickerLinesEnabled etc — already accounts for legacy boolean
  // fallback) with the alignment gate.
  const kickerShowLines = kickerLinesEnabled && kickerAlign === 'center';
  const titleShowLines = titleLinesEnabled && titleAlign === 'center';
  const subtitleShowLines = subtitleLinesEnabled && subtitleAlign === 'center';
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
                  textDecoration: kickerZone?.textDecoration,
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
          {text &&
            // Title can OPTIONALLY have flanking hairlines when
            // `dividers.title.enabled === true`. Default OFF (new slot, no
            // legacy equivalent). Same visual idiom as kicker/subtitle lines
            // — hairlines flank the centered title h2. When alignment is not
            // center the lines auto-suppress (see titleShowLines).
            (titleShowLines ? (
              <div className="self-stretch flex items-center justify-center gap-3 sm:gap-4">
                <span
                  aria-hidden
                  data-title-divider-line
                  className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
                />
                <h2
                  className={styles.sectionHeading}
                  data-zone="sectionTitle"
                  style={{
                    fontFamily: headingZone?.fontFamily,
                    fontSize: responsiveFontSize(headingZone?.fontSize),
                    fontWeight: headingZone?.fontWeight,
                    color: headingZone?.color,
                    letterSpacing: headingZone?.letterSpacing,
                    lineHeight: headingZone?.lineHeight,
                    textTransform:
                      headingZone?.textTransform as React.CSSProperties['textTransform'],
                  }}
                >
                  {text}
                </h2>
                <span
                  aria-hidden
                  data-title-divider-line
                  className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
                />
              </div>
            ) : (
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
                  textDecoration: headingZone?.textDecoration,
                }}
              >
                {text}
              </h2>
            ))}
          {subtitleText && (
            // Subtitle renders with flanking hairlines matching the
            // SectionKicker editorial-divider style (Ahmad 2026-05-17
            // evening — was manually typing "--- text ---" to fake it).
            // Lines suppressible per-section via `showSubtitleLines={false}`.
            // Long descriptive subtitles still look fine with the lines
            // — they extend `flex-1` to fill but cap at max-w so they
            // never dominate. Same `bg-foreground/30` opacity as the
            // kicker hairlines for visual consistency.
            // 2026-05-20: data-zone moved from the wrapping div to the inner
            // <p> so the `[data-zone="sectionSubtitle"] *` CSS cascade from
            // the typography emitter (apps/web/src/app/layout.tsx) no longer
            // bleeds onto the flanking line <span> siblings. Was previously
            // breaking lines when merchant set sectionSubtitle.color or
            // backgroundColor in /typography admin. Matches the kicker
            // pattern above (data-zone on the text element only).
            <div
              className={`self-stretch flex items-center gap-3 sm:gap-4 ${
                subtitleAlign === 'start'
                  ? 'justify-start'
                  : subtitleAlign === 'end'
                    ? 'justify-end'
                    : 'justify-center'
              }`}
            >
              {subtitleShowLines && (
                <span
                  aria-hidden
                  data-subtitle-divider-line
                  className="h-px flex-1 max-w-[140px] sm:max-w-[200px] bg-foreground/30"
                />
              )}
              <p
                className="text-xl text-muted-foreground max-w-2xl"
                data-zone="sectionSubtitle"
                style={{
                  fontFamily: subtitleZone?.fontFamily,
                  fontSize: responsiveFontSize(subtitleZone?.fontSize),
                  fontWeight: subtitleZone?.fontWeight,
                  color: subtitleZone?.color,
                  letterSpacing: subtitleZone?.letterSpacing,
                  lineHeight: subtitleZone?.lineHeight,
                  textTransform:
                    subtitleZone?.textTransform as React.CSSProperties['textTransform'],
                  textDecoration: subtitleZone?.textDecoration,
                }}
              >
                {subtitleText}
              </p>
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
              textDecoration: seeAllZone?.textDecoration,
            }}
          >
            {isRtl ? 'عرض الكل' : 'See all'}
          </Link>
        )}
      </div>
      {/* belowHeading divider — between this heading block and the section
          content (products / categories grid). Full DividerSettings shape;
          renders as a SectionDivider <hr>. Default OFF — merchant opts in. */}
      {dividers?.belowHeading?.enabled && <SectionDivider settings={dividers.belowHeading} />}
    </div>
  );
}
