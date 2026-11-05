'use client';

import { storefrontText } from '@ebda/shared';
import type React from 'react';
import Link from '../../components/StoreLink';
import type { SectionDividers, DividerSettings } from '@ebda/shared';
import {
  DEFAULT_DIVIDER_SETTINGS,
  resolveColor,
  pickReadableForeground,
  contrastRatio,
  resolveBackgroundPreset,
} from '@ebda/shared';
import { getPackStyles, type PackId } from './pack-styles';
import type { ResolvedZone } from './section-typography';
import { responsiveFontSize } from './section-typography';
import {
  SectionDivider,
  resolveDividerColor,
  resolveSlotDividerSettings,
  hasExplicitDividerPick,
} from './SectionDivider';
import { useStore } from '../../contexts/StoreContext';
import { settingMarker, useEditorMode } from '../../builder/render/editor-mode';

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
  pack?: PackId;
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
   * and subtitle wrapper. Merchant intent wins — no runtime auto-fix.
   */
  headingZone?: ResolvedZone;
  kickerZone?: ResolvedZone;
  subtitleZone?: ResolvedZone;
  /** Typography override for the "See all →" link at the row end. */
  seeAllZone?: ResolvedZone;
  /**
   * The resolved background color of the section that contains this heading
   * (e.g. the value from `sectionBgStyle`). When provided and the merchant
   * has NOT set an explicit heading color, the h2 color is auto-inverted via
   * `pickReadableForeground` so it is always readable on tinted backgrounds
   * (Anchor B fix — PDP-4 / YML-1, 2026-06-05).
   *
   * Pass the raw merchant value (hex OR 'token:<name>'); it is resolved here.
   * Preserve existing behavior: when headingZone already has an explicit color
   * set, this prop is ignored.
   *
   * Do NOT re-introduce a CSS --section-fg cascade — invert at render time
   * in this component instead (audit recommendation).
   */
  sectionBgColor?: string;
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
  sectionBgColor,
}: SectionHeadingProps) {
  // Per-section dividers override the legacy showKickerLines / showSubtitleLines
  // booleans when present. When the new `dividers.{kicker,title,subtitle}` is
  // undefined, fall back to the deprecated boolean props so existing stores
  // keep their current look.
  const { store } = useStore();
  // Canvas only: tag the three texts so the overlay edits the field on screen (VE-2 markers).
  const editorMode = useEditorMode();
  const mark = (base: 'title' | 'kicker' | 'subtitle') => settingMarker(editorMode, base, isRtl);

  // Anchor B (PDP-4 / YML-1): GUARANTEE a readable heading color — invert at
  // render time, never via a CSS --section-fg cascade (audit 2026-06-05).
  //
  // The background is the section bg when provided, else the painted page colour (below).
  // A saved/explicit color is honoured ONLY when it actually reads against that
  // bg (contrast >= 2:1, see floor note below). If it doesn't — e.g. a
  // stale white/light heading color on a white page (the demo-merchant "قد يعجبك
  // أيضاً" white-on-white bug) — we override with pickReadableForeground so the
  // heading is never invisible. This keeps a deliberate light-on-dark pick
  // (white on a brand-colored section reads fine) while self-correcting the
  // unreadable ones. The mechanical rule: the heading is ALWAYS legible.
  // No section bg: the section paints `--bg-page`, which is EXACTLY
  // `resolveBackgroundPreset(theme).bgPage` (StoreContext `themeToCssVars`): the theme's
  // bgPage/bgSectionAlt pair when both are set (every look sets them), else the backgroundPreset
  // (white by default, whatever `backgroundColor` says). Measure against what is painted, so a
  // dark look page (Qamar Lookbook, #1E2340) gets a light heading and a legacy store with a dark
  // `backgroundColor` but a white painted page keeps its dark heading.
  const paintedPage = store.theme
    ? `hsl(${resolveBackgroundPreset(store.theme).bgPage})`
    : undefined;
  const resolvedBg: string =
    resolveColor(sectionBgColor, store.theme) ??
    (paintedPage && pickReadableForeground(paintedPage) ? paintedPage : '#ffffff');
  const ensureReadable = (zoneColor: string | undefined): string | undefined => {
    const auto = pickReadableForeground(resolvedBg) ?? '#000000';
    if (!zoneColor) return sectionBgColor ? auto : undefined; // no explicit pick → auto-contrast
    // The merchant EXPLICITLY picked this color (the page-builder shows a live
    // preview of the result), so honour it — a manual edit must override. The
    // old 2:1 readability floor forced a deliberate light-on-light heading to
    // black, ignoring the merchant (Ahmad 2026-06-20: "I need the manual edit to
    // override"). We only self-correct a pick that is LITERALLY invisible — i.e.
    // essentially the same color as the background (contrast < 1.06 ≈
    // white-on-white) — to keep the stale-color safety without blocking a real tint.
    const concrete = resolveColor(zoneColor, store.theme) ?? zoneColor;
    // On a LIGHT bg, invisible against the painted bg OR against white (the reference this floor
    // was tuned on): a stale near-white pick on an off-white page (#FAF7F2 ≈ 1.07:1) is still
    // corrected, exactly as when this measured against white alone. On a dark bg (a dark look),
    // only the painted bg counts, so a merchant's light tint there is honoured.
    const vsBg = contrastRatio(resolvedBg, concrete);
    const seen = auto === '#000000' ? Math.min(vsBg, contrastRatio('#ffffff', concrete)) : vsBg;
    return seen >= 1.06 ? zoneColor : auto;
  };
  // When there is no explicit color AND no section bg, fall back to a guaranteed
  // dark default rather than inheriting (which on a white page can resolve to an
  // invisible light zone color via the emitted per-store CSS).
  const resolvedHeadingColor: string | undefined =
    ensureReadable(headingZone?.color) ?? pickReadableForeground(resolvedBg) ?? '#000000';
  const resolvedSubtitleColor: string | undefined =
    ensureReadable(subtitleZone?.color) ?? pickReadableForeground(resolvedBg) ?? '#000000';
  const kickerLinesEnabled = dividers?.kicker?.enabled ?? showKickerLines !== false;
  const titleLinesEnabled = dividers?.title?.enabled ?? false;
  const subtitleLinesEnabled = dividers?.subtitle?.enabled ?? showSubtitleLines !== false;

  // Compute the flanking line style for each slot from the merchant's saved
  // DividerSettings. The line was hardcoded `bg-foreground/30` (Tailwind class)
  // which silently ignored merchant `customColor` / `color` / `thickness` picks
  // — verified Ebda Store 2026-05-20: Ahmad saved customColor=token:card for the
  // categories subtitle divider but the storefront kept rendering the default
  // foreground hairline. Fix: resolve the merchant's pick via the canonical
  // resolveDividerColor helper and apply as inline backgroundColor + height.
  //
  // When the merchant left settings at default (`color: 'auto'` and no other
  // overrides), keep the legacy `bg-foreground/30` editorial-hairline class so
  // existing stores see zero visual change.
  //
  // 2026-06-04: a slot enabled AFTER the merchant picked the section's shared
  // colour gets saved as `{ enabled: true }` only, so it rendered the default
  // foreground hairline instead of the picked colour (Ahmad: "around title do
  // not take the color i picked … I want them as the subtitle does"). The
  // canonical fix lives in `resolveSlotDividerSettings` — every slot inherits
  // the section's shared pick when it has none of its own. See SectionDivider.
  const flankingLineStyle = (slotKey: 'kicker' | 'title' | 'subtitle') => {
    const effective = resolveSlotDividerSettings(dividers, slotKey);
    if (!hasExplicitDividerPick(effective)) return undefined;
    const merged: DividerSettings = { ...DEFAULT_DIVIDER_SETTINGS, ...effective };
    const color = resolveDividerColor(merged, store.theme);
    return {
      backgroundColor: color,
      height: `${merged.thickness ?? 1}px`,
    } as React.CSSProperties;
  };
  const kickerLineStyle = flankingLineStyle('kicker');
  const titleLineStyle = flankingLineStyle('title');
  const subtitleLineStyle = flankingLineStyle('subtitle');
  // Tailwind fallback class — used only when the merchant didn't pick.
  const FLANK_DEFAULT_CLS = 'h-px bg-foreground/30';
  const flankBaseCls = 'flex-1 max-w-[140px] sm:max-w-[200px]';
  const text = storefrontText(isRtl ? (titleAr ?? title) : (title ?? titleAr), !!isRtl);
  const kickerText = isRtl ? (kickerAr ?? kicker) : (kicker ?? kickerAr);
  const subtitleText = storefrontText(
    isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr),
    !!isRtl
  );
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
  const packAlign = getPackStyles(pack).sectionHeadingAlign ?? 'center';
  const kickerAlign = kickerZone?.textAlign ?? packAlign;
  const titleAlign = headingZone?.textAlign ?? packAlign;
  const subtitleAlign = subtitleZone?.textAlign ?? packAlign;
  // 2026-05-20: removed the `&& align === 'center'` gate that previously
  // auto-suppressed flanking hairlines for non-centered text. That was
  // me second-guessing the merchant — if they explicitly enable the
  // toggle, render the lines regardless of alignment. Merchant turns
  // OFF if they don't like the look with start/end-aligned text.
  // Was suppressing subtitle lines on demo-merchant (Ahmad 2026-05-20).
  const kickerShowLines = kickerLinesEnabled;
  const titleShowLines = titleLinesEnabled;
  const subtitleShowLines = subtitleLinesEnabled;
  // IA-16: a start-aligned title shares one baseline row with See all; a centred or
  // hairline-flanked title has no end edge to share, so the link keeps its own row below.
  const seeAllInline = Boolean(seeAllHref && text) && titleAlign === 'start' && !titleShowLines;
  const seeAllLink = (inline: boolean) => (
    <Link
      href={seeAllHref ?? ''}
      className={
        inline
          ? `inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center ${styles.sectionSeeAll}`
          : // Audit 2026-11-03 #6: not the far end of the row, 12-14 px and 44 px away from its heading.
            // It sits directly under the heading block, aligned like the title, 44 px tall.
            `inline-flex min-h-11 items-center gap-1.5 px-3 ${styles.sectionSeeAll}`
      }
      data-zone="sectionSeeAll"
      // The data-cta="link" hover effect is a from-center underline (a
      // background-gradient line, NOT text-decoration). A merchant who set
      // the See-all zone's text decoration to "none" means "no underline" —
      // honour that by dropping data-cta so the hover line doesn't fire.
      data-cta={seeAllZone?.textDecoration === 'none' ? undefined : 'link'}
      style={{
        fontFamily: seeAllZone?.fontFamily,
        // 15 px unless the merchant sized the zone (the pack classes said 14 px and under).
        fontSize: responsiveFontSize(seeAllZone?.fontSize) ?? '0.9375rem',
        fontWeight: seeAllZone?.fontWeight,
        color: seeAllZone?.color,
        letterSpacing: seeAllZone?.letterSpacing,
        lineHeight: seeAllZone?.lineHeight,
        textTransform: seeAllZone?.textTransform as React.CSSProperties['textTransform'],
        textDecoration: seeAllZone?.textDecoration,
        textAlign: seeAllZone?.textAlign as React.CSSProperties['textAlign'],
      }}
    >
      {isRtl ? 'عرض الكل' : 'See all'}
      {!inline && (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 shrink-0 rtl:-scale-x-100"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      )}
    </Link>
  );
  return (
    <div className="mb-8 flex flex-col gap-2 sm:mb-12 sm:gap-3">
      {/* relative row: title-block is full-width-centered, seeAll absolute-anchored
          on the end edge. Mobile-first — on narrow viewports seeAll drops below
          the heading block instead of overlapping the centered title. */}
      <div className="relative">
        <div className="flex flex-col items-stretch gap-2">
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
                  className={
                    kickerLineStyle ? flankBaseCls : `${FLANK_DEFAULT_CLS} ${flankBaseCls}`
                  }
                  style={kickerLineStyle}
                />
              )}
              <span
                className="text-xs font-semibold ui-caps-toggle tracking-[0.18em] text-foreground/70"
                data-zone="sectionKicker"
                {...mark('kicker')}
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
                  className={
                    kickerLineStyle ? flankBaseCls : `${FLANK_DEFAULT_CLS} ${flankBaseCls}`
                  }
                  style={kickerLineStyle}
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
              <div
                className={`self-stretch flex items-center gap-3 sm:gap-4 ${
                  titleAlign === 'start'
                    ? 'justify-start'
                    : titleAlign === 'end'
                      ? 'justify-end'
                      : 'justify-center'
                }`}
              >
                <span
                  aria-hidden
                  data-title-divider-line
                  className={titleLineStyle ? flankBaseCls : `${FLANK_DEFAULT_CLS} ${flankBaseCls}`}
                  style={titleLineStyle}
                />
                <h2
                  className={styles.sectionHeading}
                  data-zone="sectionTitle"
                  {...mark('title')}
                  style={{
                    fontFamily: headingZone?.fontFamily,
                    fontSize: responsiveFontSize(headingZone?.fontSize),
                    fontWeight: headingZone?.fontWeight,
                    // resolvedHeadingColor: explicit merchant pick wins; falls back
                    // to auto-invert against sectionBgColor when no explicit color.
                    color: resolvedHeadingColor,
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
                  className={titleLineStyle ? flankBaseCls : `${FLANK_DEFAULT_CLS} ${flankBaseCls}`}
                  style={titleLineStyle}
                />
              </div>
            ) : seeAllInline ? (
              <div data-heading-row className="flex items-baseline justify-between gap-x-6">
                <h2
                  className={`min-w-0 ${styles.sectionHeading} ${
                    titleAlign === 'start'
                      ? 'text-start'
                      : titleAlign === 'end'
                        ? 'text-end'
                        : 'text-center'
                  }`}
                  data-zone="sectionTitle"
                  {...mark('title')}
                  style={{
                    fontFamily: headingZone?.fontFamily,
                    fontSize: responsiveFontSize(headingZone?.fontSize),
                    fontWeight: headingZone?.fontWeight,
                    // resolvedHeadingColor: explicit merchant pick wins; falls back
                    // to auto-invert against sectionBgColor when no explicit color.
                    color: resolvedHeadingColor,
                    letterSpacing: headingZone?.letterSpacing,
                    lineHeight: headingZone?.lineHeight,
                    textTransform:
                      headingZone?.textTransform as React.CSSProperties['textTransform'],
                    textDecoration: headingZone?.textDecoration,
                  }}
                >
                  {text}
                </h2>
                {seeAllLink(true)}
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
                {...mark('title')}
                style={{
                  fontFamily: headingZone?.fontFamily,
                  fontSize: responsiveFontSize(headingZone?.fontSize),
                  fontWeight: headingZone?.fontWeight,
                  // resolvedHeadingColor: explicit merchant pick wins; falls back
                  // to auto-invert against sectionBgColor when no explicit color.
                  color: resolvedHeadingColor,
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
                  className={
                    subtitleLineStyle ? flankBaseCls : `${FLANK_DEFAULT_CLS} ${flankBaseCls}`
                  }
                  style={subtitleLineStyle}
                />
              )}
              <p
                className="text-base text-muted-foreground max-w-2xl text-pretty"
                data-zone="sectionSubtitle"
                {...mark('subtitle')}
                style={{
                  fontFamily: subtitleZone?.fontFamily,
                  fontSize: responsiveFontSize(subtitleZone?.fontSize),
                  fontWeight: subtitleZone?.fontWeight,
                  // resolvedSubtitleColor: explicit merchant pick wins; falls back
                  // to auto-invert against sectionBgColor so subtitle is readable.
                  color: resolvedSubtitleColor,
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
                  className={
                    subtitleLineStyle ? flankBaseCls : `${FLANK_DEFAULT_CLS} ${flankBaseCls}`
                  }
                  style={subtitleLineStyle}
                />
              )}
            </div>
          )}
        </div>
        {seeAllHref && !seeAllInline && (
          <div
            data-see-all-row
            className={`flex ${
              titleAlign === 'start'
                ? 'justify-start'
                : titleAlign === 'end'
                  ? 'justify-end'
                  : 'justify-center'
            }`}
          >
            {seeAllLink(false)}
          </div>
        )}
      </div>
      {/* belowHeading divider — between this heading block and the section
          content (products / categories grid). Full DividerSettings shape;
          renders as a SectionDivider <hr>. Default OFF — merchant opts in. */}
      {dividers?.belowHeading?.enabled && (
        <SectionDivider settings={resolveSlotDividerSettings(dividers, 'belowHeading')} />
      )}
    </div>
  );
}
