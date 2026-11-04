import { resolveColor, pickReadableForeground, contrastRatio } from '@ebda/shared';
import type { ZoneOverride, StoreTheme } from '@ebda/shared';
import type { CSSProperties } from 'react';

export interface ResolvedZone {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  letterSpacing?: string;
  lineHeight?: string;
  textTransform?: string;
  textDecoration?: string;
  textAlign?: 'start' | 'center' | 'end';
}

/**
 * Merge a section-level typography override with the global zone from the
 * typography admin. Section override wins per-field; global fills the rest;
 * theme defaults handle anything not set anywhere. Returns undefined when
 * neither has any value so the caller can render with raw theme defaults.
 *
 * Color values (hex OR 'token:<name>') are resolved against the live theme
 * here so the consumer always gets a real CSS color string.
 *
 * @param sectionBgColor - The resolved background color of the section wrapper.
 *   When provided AND no explicit heading color is set by the merchant, the
 *   foreground is auto-inverted via `pickReadableForeground` so the heading is
 *   always readable on tinted / light-colored section backgrounds (Anchor B fix,
 *   PDP-4 / YML-1). Pass the raw merchant value (e.g. "token:primary" or "#fff");
 *   it is resolved internally. Do NOT re-add a CSS --section-fg cascade — invert
 *   at render time here instead (audit recommendation, 2026-06-05).
 */
export function resolveSectionZone(
  sectionOverride: ZoneOverride | undefined,
  globalZone: ZoneOverride | undefined,
  theme: StoreTheme,
  sectionBgColor?: string
): ResolvedZone | undefined {
  const hasAnyInput = !!(sectionOverride || globalZone || sectionBgColor);
  if (!hasAnyInput) return undefined;

  const merged: ResolvedZone = {};
  const pick = <K extends keyof ZoneOverride>(key: K) => {
    const v = sectionOverride?.[key] ?? globalZone?.[key];
    if (v !== undefined) {
      (merged as Record<string, unknown>)[key] = v;
    }
  };

  pick('fontFamily');
  pick('fontSize');
  pick('fontWeight');
  pick('letterSpacing');
  pick('lineHeight');
  pick('textTransform');
  pick('textDecoration');
  pick('textAlign');

  // Color resolution strategy (Anchor B):
  // 1. Merchant-set explicit color always wins (preserves existing behavior).
  // 2. When no explicit color is set AND a section background is provided,
  //    auto-invert via pickReadableForeground so the heading never goes
  //    white-on-white or dark-on-dark on tinted sections.
  // 3. No explicit color + no section bg → leave color undefined so CSS
  //    inherits the theme default (text-foreground).
  const rawColor = sectionOverride?.color ?? globalZone?.color;
  if (rawColor) {
    // Explicit pick — resolve token refs. CONTRAST GUARD (2026-06-06): a color
    // tuned for one section bg (e.g. a baseline `token:card` white meant for a
    // dark section) becomes invisible when the same baseline renders on a light
    // surface in a different template. So when a section bg is known and the
    // explicit color fails the 3:1 floor against it, override with a readable
    // foreground. Colors that already read fine (demo-merchant) are kept verbatim,
    // so configured stores are unchanged. Mirrors SectionHeading.ensureReadable.
    const resolved = resolveColor(rawColor, theme);
    const resolvedBg = sectionBgColor ? resolveColor(sectionBgColor, theme) : undefined;
    if (resolved && resolvedBg && contrastRatio(resolvedBg, resolved) < 3) {
      merged.color = pickReadableForeground(resolvedBg) ?? resolved;
    } else {
      merged.color = resolved;
    }
  } else if (sectionBgColor) {
    // No explicit pick: auto-invert against the section background.
    const resolvedBg = resolveColor(sectionBgColor, theme);
    const autoColor = pickReadableForeground(resolvedBg) ?? '#000000';
    merged.color = autoColor;
  }

  return Object.keys(merged).length ? merged : undefined;
}

/**
 * The product-card CTA ("Add to cart" / "View") text color, contrast-guarded
 * against the BUTTON's own background (2026-06-06).
 *
 * Each pack's `productCardCta` class sets the button background (classic/bold →
 * `bg-foreground`, modern → `bg-primary`, minimal/elegant → `bg-transparent`)
 * AND a matching readable `text-*` color. But an inline productCta zone color
 * overrides that text color — so a color tuned elsewhere (e.g. the baseline
 * `token:foreground`) renders dark-on-dark on a filled dark button.
 *
 * This returns the zone color when it reads ≥3:1 against the button bg (so a
 * deliberate, readable pick — including demo-merchant's — is kept), and `undefined`
 * when it fails, letting the pack's designed `text-*` class win. When the button
 * bg is transparent/unknown it guards against the section bg instead and, if
 * still unreadable, returns a guaranteed-readable foreground.
 *
 * @param zoneColor  already-resolved color from `resolveSectionZone` (or undefined)
 * @param packCtaClass the pack's `productCardCta` class string
 */
export function guardedCtaColor(
  zoneColor: string | undefined,
  packCtaClass: string,
  theme: StoreTheme
): string | undefined {
  if (!zoneColor) return undefined;
  // Only guard FILLED buttons — those with a solid bg token in the pack class
  // (classic/bold → bg-foreground, modern → bg-primary). Their text sits on a
  // known, solid surface, so we can reliably detect dark-on-dark and drop the
  // override (letting the pack's text-* class win).
  //
  // For a TRANSPARENT / unknown button (minimal/elegant → bg-transparent) the
  // text sits on the CARD surface, NOT the section — so guessing the bg from
  // the section background is wrong (it forced white text onto a white card =
  // white-on-white, 2026-06-06 regression). Leave those colors as the pack
  // intends (text-foreground, readable on the card).
  const m = packCtaClass.match(
    /\bbg-(primary|foreground|secondary|accent|card|muted|background)\b/
  );
  if (!m) return zoneColor;
  const bg = resolveColor(`token:${m[1]}`, theme);
  if (bg && contrastRatio(bg, zoneColor) < 3) return undefined;
  return zoneColor;
}

/**
 * Wrap a merchant-set px fontSize with a responsive `clamp()` so it scales
 * gracefully on narrow mobile. Mobile floor = max(70% of merchant value, 14px).
 * At ≥768px viewport, renders at the merchant value. Linear interp in between.
 *
 * Returns the original value unchanged when:
 *   - undefined
 *   - non-px unit (em / rem / % / vw)
 *   - already ≤16px (already mobile-safe)
 *
 * Rejects Tailwind arbitrary-value bracket syntax (`text-[Npx]`) — those
 * bypass the 4-step scale (12/14/16/18/22px), win specificity over the
 * per-store CSS emitter, and silently no-op merchant overrides (PC-4 fix,
 * 2026-06-05). Allowed inputs: px / rem / em / % values, or documented
 * token names (text-xs / text-sm / text-base / text-lg / text-xl / text-2xl).
 * Bracket syntax is returned as undefined so the element falls back to its
 * Tailwind class instead of injecting an invalid inline style.
 *
 * Verified 2026-05-20 against demo-merchant: global sectionTitle.fontSize="22px"
 * → clamp(15.40px, calc(8.82px + 1.716vw), 22px) → renders 15.4px on 360px
 * mobile, 22px on tablet+. Was previously 22px on every viewport, which
 * broke mobile heading wrap.
 */
export function responsiveFontSize(size: string | undefined): string | undefined {
  if (!size) return undefined;
  // PC-4: reject Tailwind arbitrary bracket syntax (text-[20px], text-[1.2rem], etc.).
  // These must NOT be passed as inline styles — they're Tailwind classes.
  if (/text-\[/.test(size)) return undefined;
  const match = size.match(/^([\d.]+)px$/);
  if (!match) return size; // non-px unit — return as-is
  const value = parseFloat(match[1]);
  if (value <= 16) return size; // already mobile-safe
  const mobileFloor = Math.max(value * 0.7, 14);
  // Linear interp from mobileFloor @ 360px → value @ 768px viewport
  const slope = (value - mobileFloor) / (768 - 360);
  const intercept = mobileFloor - slope * 360;
  return `clamp(${mobileFloor.toFixed(2)}px, calc(${intercept.toFixed(2)}px + ${(slope * 100).toFixed(3)}vw), ${value}px)`;
}

/**
 * Convert a resolved zone to an inline style object. Inline wins over the
 * element's own Tailwind size classes — the reliable way to apply a merchant's
 * per-page typography (used by the cart + the per-page design controls). Returns
 * undefined when the zone is empty so callers can spread it safely.
 */
/** Multiply a px font-size by the page text-scale before the responsive clamp.
 *  Non-px sizes pass through unscaled (can't safely multiply em/rem here). */
function scalePx(size: string | undefined, scale: number): string | undefined {
  if (!size || scale === 1) return size;
  const m = size.match(/^([\d.]+)px$/);
  if (!m) return size;
  return `${(parseFloat(m[1]) * scale).toFixed(2)}px`;
}

/**
 * @param scale per-page text-size multiplier (see pageTextScale). 1 = unchanged.
 */
export function zoneStyle(zone?: ResolvedZone, scale = 1): CSSProperties | undefined {
  if (!zone) return undefined;
  return {
    fontFamily: zone.fontFamily,
    // Scale by the page text dial, then responsive-clamp so a large size never
    // breaks mobile.
    fontSize: responsiveFontSize(scalePx(zone.fontSize, scale)),
    fontWeight: zone.fontWeight,
    color: zone.color,
    letterSpacing: zone.letterSpacing,
    // Ratio safety (mirrors the homepage CSS emitter): when the merchant bumps
    // the size but doesn't set a line-height, pin an Arabic-friendly 1.6 so the
    // bigger glyphs (ش / خ / ة with upper diacritics) always have vertical room
    // and don't clip against a tight default. Merchant-set line-height wins.
    lineHeight: zone.lineHeight ?? (zone.fontSize ? '1.6' : undefined),
    textTransform: zone.textTransform as CSSProperties['textTransform'],
    textAlign: zone.textAlign,
  };
}

/** Map a per-page text-scale dial to a numeric multiplier. */
export function pageTextScale(scale: 'sm' | 'normal' | 'lg' | 'xl' | undefined): number {
  return scale === 'sm' ? 0.9 : scale === 'lg' ? 1.15 : scale === 'xl' ? 1.3 : 1;
}

/** Return a copy of a zone with its px font-size multiplied by `scale`. Used
 *  when a zone is forwarded into a theme component that applies it itself
 *  (cart CartTable/OrderSummary, category cards) rather than via zoneStyle(). */
export function scaleZone(zone: ResolvedZone | undefined, scale: number): ResolvedZone | undefined {
  if (!zone || scale === 1) return zone;
  return { ...zone, fontSize: scalePx(zone.fontSize, scale) };
}

/**
 * Per-page spacing density → inline padding override for the page container.
 * 'normal'/undefined returns undefined so the element's default py- class wins.
 */
export function pageDensityStyle(
  density: 'compact' | 'normal' | 'spacious' | undefined
): CSSProperties | undefined {
  if (density === 'compact') return { paddingTop: '1rem', paddingBottom: '1rem' };
  if (density === 'spacious') return { paddingTop: '3.5rem', paddingBottom: '3.5rem' };
  return undefined;
}

/**
 * Hero headline size (audit 2026-11-03 #3, Ruling PREMIUM-3): design.md makes the hero headline
 * the one scale exception, 36px on a phone to 72px on desktop. A merchant typography zone used to
 * be able to pull it down to 14px (`responsiveFontSize` floors at 70% of the pick, min 14px).
 * Here the zone size can only RAISE the ceiling (a 96px pick keeps 96px on desktop); it can never
 * take the headline under the 36px floor. One fluid clamp, 36px at 390px wide, 72px from 1100px.
 */
export const HERO_HEADLINE_SIZE = 'clamp(2.25rem, 1.2rem + 4.4vw, 4.5rem)';
export function heroHeadlineFontSize(zoneSize: string | undefined): string {
  const px = zoneSize?.match(/^([\d.]+)px$/);
  const ceiling = px ? parseFloat(px[1]) : 0;
  if (ceiling > 72) return `clamp(2.25rem, 1.2rem + 4.4vw, ${ceiling / 16}rem)`;
  return HERO_HEADLINE_SIZE;
}
