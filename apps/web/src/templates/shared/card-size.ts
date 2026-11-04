/**
 * Shared per-store card-size + aspect-ratio helpers used across the
 * every template. Map admin-picked size enum → tailwind classes that drive
 * the `max-w-*` cap on each card wrapper, and aspect override →
 * `aspect-*` class that overrides the per-theme default.
 *
 * Both helpers fall back to safe defaults so a missing or unknown
 * value never breaks render. Defaults match Ahmad's 2026-05-16
 * "smaller" preference (sm category, sm product).
 */
import { getLook } from '@ebda/shared';
import type {
  CardAspect,
  CardFrameSize,
  CardFrameWidth,
  CardGap,
  CardImageAspect,
  CardImageRadius,
  CardShape,
  CardSize,
} from '@ebda/shared';

/**
 * Category card size → tailwind max-w classes (mobile + desktop).
 * The cap is what visually shrinks/grows the card; aspect ratio is
 * controlled separately via `categoryAspectClass`.
 */
export function categorySizeClass(size: CardSize | undefined): string {
  switch (size) {
    case 'xxs':
      return 'max-w-[90px] md:max-w-[110px]';
    case 'xs':
      return 'max-w-[120px] md:max-w-[140px]';
    case 'md':
      return 'max-w-[200px] md:max-w-[240px]';
    case 'lg':
      return 'max-w-[240px] md:max-w-[300px]';
    case 'xl':
      return 'max-w-[280px] md:max-w-[360px]';
    case 'sm':
    default:
      return 'max-w-[150px] md:max-w-[180px]';
  }
}

/**
 * Product card size → tailwind max-w classes. Slightly bigger ranges
 * than category cards because product cards carry more content (image
 * + name + price + CTA).
 */
export function productSizeClass(size: CardSize | undefined): string {
  switch (size) {
    case 'xxs':
      return 'max-w-[110px] md:max-w-[130px]';
    case 'xs':
      return 'max-w-[140px] md:max-w-[160px]';
    case 'md':
      return 'max-w-[200px] md:max-w-[240px]';
    case 'lg':
      return 'max-w-[240px] md:max-w-[280px]';
    case 'xl':
      return 'max-w-[280px] md:max-w-[320px]';
    case 'sm':
    default:
      return 'max-w-[170px] md:max-w-[200px]';
  }
}

/**
 * Map per-store gap setting → Tailwind `gap-*` classes for category /
 * product grids + carousels. Mobile + desktop tiers so a tight phone
 * grid can still breathe on desktop. Default 'normal' keeps the prior
 * baseline (gap-3 sm:gap-4) when the field is unset.
 *
 * Static-string enumeration so JIT keeps every class — don't refactor
 * to dynamic interpolation.
 */
export function gridGapClass(gap: CardGap | undefined): string {
  switch (gap) {
    case 'tight':
      // PREMIUM-4: never tighter than 12px (audit 2026-11-03 #4: cards read as butted together).
      return 'gap-3';
    case 'loose':
      return 'gap-4 sm:gap-6';
    case 'xloose':
      return 'gap-8 sm:gap-10';
    case 'normal':
    default:
      return 'gap-3 sm:gap-4';
  }
}

/**
 * Named card shape → tailwind class pair (aspect + rounding) for
 * category tiles. When 'theme' or undefined, returns empty strings so
 * the theme's own defaults (aspectClass + rounded-*) apply.
 *
 * Static-string enumeration so JIT keeps every class — don't refactor
 * to dynamic concatenation.
 */
export function cardShapeClasses(shape: CardShape | undefined): {
  aspect: string;
  radius: string;
} {
  switch (shape) {
    case 'circle':
      return { aspect: 'aspect-square', radius: 'rounded-full' };
    case 'rounded-square':
      return { aspect: 'aspect-square', radius: 'rounded-2xl' };
    case 'square':
      return { aspect: 'aspect-square', radius: 'rounded-none' };
    case 'soft':
      return { aspect: 'aspect-[4/5]', radius: 'rounded-lg' };
    case 'portrait':
      return { aspect: 'aspect-[3/4]', radius: 'rounded-md' };
    case 'landscape':
      return { aspect: 'aspect-[4/3]', radius: 'rounded-md' };
    case 'pill':
      return { aspect: 'aspect-[2/1]', radius: 'rounded-full' };
    case 'theme':
    default:
      return { aspect: '', radius: '' };
  }
}

/**
 * Optional per-card "framed" wrapper. Returns '' when off (no-op div) or
 * a tailwind class string per the chosen style. Used by CategoryStrip,
 * per-theme CategoryGrid, and ProductCarousel.
 *
 *   soft    — rounded-2xl + bg-card + subtle shadow (modern / SaaS feel)
 *   outline — rounded-xl + 2px border, no bg, no shadow (classic / minimal)
 *   shadow  — rounded-2xl + bg-card + larger shadow, no border (premium)
 *   paper   — rounded-lg + bg-card + paper shadow + larger padding (editorial)
 *
 * Default style when `showCardFrame` is true but no style picked: 'soft'.
 * Added 2026-05-17 night; styles enum added 2026-05-18 per Ahmad's ask
 * for customization options.
 */
export type CardFrameStyle = 'soft' | 'outline' | 'shadow' | 'paper';

export function cardFrameClass(
  on: boolean | undefined,
  style: CardFrameStyle | undefined = 'soft'
): string {
  if (!on) return '';
  // 2026-05-18 visibility bump (Ahmad: frames not appearing): bumped
  // border opacities to foreground/15-30 + shadow strength so frames
  // are clearly visible on pure-white themes (demo-merchant / elegant where
  // bg-card == bg-page == white). Previously `border-border` resolved
  // to near-white and the frame was invisible.
  // Border widths (border / border-2 / border-4 / border-8) are intentionally
  // OMITTED here. They are controlled exclusively by cardFrameWidthClass() so
  // combining both helpers never produces a double border-width conflict.
  // The border-color classes (border-foreground/XX) are kept — they set color
  // only and don't collide with width classes.
  // Padding is intentionally OMITTED here — controlled exclusively by
  // cardFrameSizeClass() so the two helpers never produce conflicting p-N.
  // border-color classes (border-foreground/XX) are kept; they only set
  // color and don't conflict with width classes from cardFrameWidthClass().
  switch (style) {
    case 'outline':
      return 'rounded-xl border-foreground/25 bg-card/50 transition-colors duration-[var(--duration-base)] hover:border-foreground/45';
    case 'shadow':
      return 'rounded-2xl border-foreground/10 bg-card shadow-md transition-shadow duration-[var(--duration-base)] hover:shadow-lg';
    case 'paper':
      return 'rounded-lg border-foreground/10 bg-card shadow-[0_10px_28px_-12px_hsl(var(--foreground)/0.25)] transition-shadow duration-[var(--duration-base)] hover:shadow-[0_14px_36px_-12px_hsl(var(--foreground)/0.30)]';
    case 'soft':
    default:
      return 'rounded-2xl border-foreground/15 bg-card shadow-md transition-shadow duration-[var(--duration-base)] hover:shadow-lg';
  }
}

/**
 * Map the merchant's chosen frame SIZE (padding / breathing room between
 * content and border) to a Tailwind padding utility. Used alongside
 * `cardFrameClass` + `cardFrameWidthClass` — the three helpers control
 * distinct CSS axes (style, border-thickness, padding).
 *
 * Callers should apply this only when `showCardFrame` is true:
 *   `${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''} ${showCardFrame ? cardFrameSizeClass(cardFrameSize) : ''}`
 *
 * Static enumeration so Tailwind JIT keeps every class.
 */
export function cardFrameSizeClass(size: CardFrameSize | undefined): string {
  switch (size) {
    case 'compact':
      return 'p-2';
    case 'comfortable':
      return 'p-4';
    case 'spacious':
      return 'p-6';
    case 'normal':
    default:
      return 'p-3';
  }
}

/**
 * Map the merchant's chosen frame border width to the matching Tailwind
 * border-width utility. Used alongside `cardFrameClass` — the two helpers
 * are intentionally split so width and style don't fight each other.
 *
 * Callers should apply this only when `showCardFrame` is true:
 *   `${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''}`
 *
 * Static enumeration so Tailwind JIT keeps every class.
 */
export function cardFrameWidthClass(width: CardFrameWidth | undefined): string {
  switch (width) {
    case 'normal':
      return 'border-2';
    case 'thick':
      return 'border-4';
    case 'xthick':
      return 'border-8';
    case 'thin':
    default:
      return 'border';
  }
}

/**
 * Card aspect override. Returns '' when set to 'theme' so the theme's
 * own default applies; returns an explicit `aspect-*` class otherwise.
 */
export function cardAspectClass(aspect: CardAspect | undefined): string {
  switch (aspect) {
    case 'square':
      return 'aspect-square';
    case 'portrait':
      return 'aspect-[3/4]';
    case 'landscape':
      return 'aspect-[4/3]';
    case 'wide':
      return 'aspect-[3/2]';
    case 'ultrawide':
      return 'aspect-[16/9]';
    case 'theme':
    default:
      return '';
  }
}

/**
 * Compose tailwind grid-cols classes from the merchant's admin-picked
 * mobile + desktop column counts. Mobile cap is 3, desktop cap is 4
 * (per CategoriesSettings union types). sm/md breakpoints scale up
 * proportionally so the transition between mobile↔desktop column
 * counts is smooth on tablet viewports.
 *
 * Tailwind static-class enumeration: classes appear here so the JIT
 * scanner picks them up. Don't refactor to dynamic concatenation.
 */
export function gridColsClass(
  mobileColumns: 1 | 2 | 3 | undefined,
  desktopColumns: 2 | 3 | 4 | undefined
): string {
  const mobile = mobileColumns ?? 2;
  const desktop = desktopColumns ?? 4;

  // Intermediate sm/md columns interpolate between mobile and desktop
  // so the grid doesn't jump from 2 to 6 in one breakpoint.
  const sm = Math.min(desktop, Math.max(mobile + 1, 2));
  const md = Math.min(desktop, Math.max(mobile + 1, desktop));

  const mobileCls = mobile === 1 ? 'grid-cols-1' : mobile === 2 ? 'grid-cols-2' : 'grid-cols-3';
  const smCls = sm === 2 ? 'sm:grid-cols-2' : sm === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-4';
  const mdCls = md === 2 ? 'md:grid-cols-2' : md === 3 ? 'md:grid-cols-3' : 'md:grid-cols-4';
  const lgCls =
    desktop === 2 ? 'lg:grid-cols-2' : desktop === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4';

  return `${mobileCls} ${smCls} ${mdCls} ${lgCls}`;
}

/**
 * Item 8 — card image aspect override.
 * Maps the merchant's chosen CardImageAspect → a Tailwind aspect-ratio class
 * for the image wrapper div inside a product card.
 * Returns '' when undefined so the template's own default applies.
 *
 * Static-string enumeration so Tailwind JIT keeps every class.
 */
export function cardImageAspectClass(aspect: CardImageAspect | undefined): string {
  switch (aspect) {
    case '1:1':
      return 'aspect-square';
    case '4:5':
      return 'aspect-[4/5]';
    case '3:4':
      return 'aspect-[3/4]';
    case '16:9':
      return 'aspect-video';
    case 'auto':
      return '';
    default:
      return '';
  }
}

/**
 * Looks (Phase S) — the look's image ratio as the DEFAULT card image aspect.
 * Sits BELOW every merchant choice (cardImageAspect, cardShape, cardAspect —
 * Ruling LOOKS-3) and ABOVE only the template's own default. '' for a store
 * with no valid look, so legacy markup is byte-identical. The var is set on
 * :root by themeToCssVars.
 */
export function lookImageAspectClass(look: string | null | undefined): string {
  return getLook(look) ? 'aspect-[var(--image-ratio,4/5)]' : '';
}

/**
 * Item 8 — card image corner-radius override.
 * Maps the merchant's chosen CardImageRadius → a Tailwind border-radius class
 * applied on the image wrapper div.
 * Returns '' when undefined so the template's own rounding applies.
 *
 * Static-string enumeration so Tailwind JIT keeps every class.
 */
export function cardImageRadiusClass(radius: CardImageRadius | undefined): string {
  switch (radius) {
    case 'none':
      return 'rounded-none';
    case 'sm':
      return 'rounded';
    case 'md':
      return 'rounded-lg';
    case 'lg':
      return 'rounded-2xl';
    case 'full':
      return 'rounded-full';
    default:
      return '';
  }
}

/**
 * CTA button shape (the 4-shape vocabulary: Rounded / Pill / Square / Soft).
 * Returns '' on 'theme'/undefined so the caller keeps its existing theme class.
 * Static-string enumeration — don't refactor to dynamic concatenation (JIT).
 */
export type CtaShape = 'rounded' | 'pill' | 'square' | 'soft';
export function ctaShapeClass(shape?: CtaShape): string {
  switch (shape) {
    case 'pill':
      return 'rounded-full';
    case 'square':
      return 'rounded-none';
    case 'soft':
      return 'rounded-md';
    case 'rounded':
      return 'rounded-lg';
    default:
      return '';
  }
}

/** CTA button size; '' = derive from cardSize textSizes.btn (existing behavior). */
export type CtaSize = 'sm' | 'md' | 'lg';
export function ctaSizeClass(size?: CtaSize): string {
  switch (size) {
    case 'sm':
      return 'min-h-8 px-2.5 py-1 text-xs sm:px-2.5 sm:text-xs';
    case 'md':
      return 'min-h-10 px-2.5 py-2 text-xs sm:px-4 sm:text-sm';
    case 'lg':
      return 'min-h-12 px-3 py-3 text-sm sm:px-6 sm:text-base';
    default:
      return '';
  }
}

/** OOS badge corner shape — same 4-shape vocabulary, defaults to rounded-md. */
export function labelShapeClass(shape?: CtaShape): string {
  return ctaShapeClass(shape) || 'rounded-md';
}

/** OOS badge placement → absolute corner classes (RTL-aware via start/end). */
export function oosPlacementClass(
  p?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'
): string {
  switch (p) {
    case 'top-end':
      return 'top-2 end-2';
    case 'bottom-start':
      return 'bottom-2 start-2';
    case 'bottom-end':
      return 'bottom-2 end-2';
    case 'top-start':
    default:
      return 'top-2 start-2';
  }
}

/**
 * Taste re-audit P2-8: a look store's carousel card is one grid column wide from lg, so the
 * carousel and the 4-column grid share column edges (5 cards ending mid-row read as ragged).
 * The width is 25% less this row gap's share (3 gaps across 4 columns, at the sm+ gap value).
 */
export function lookCarouselLgWidth(gap: CardGap | undefined): string {
  switch (gap) {
    case 'tight':
      return 'lg:w-[calc(25%-9px)]';
    case 'loose':
      return 'lg:w-[calc(25%-18px)]';
    case 'xloose':
      return 'lg:w-[calc(25%-30px)]';
    default:
      return 'lg:w-[calc(25%-12px)]';
  }
}
