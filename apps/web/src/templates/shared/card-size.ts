/**
 * Shared per-store card-size + aspect-ratio helpers used across the
 * 5 themes. Map admin-picked size enum → tailwind classes that drive
 * the `max-w-*` cap on each card wrapper, and aspect override →
 * `aspect-*` class that overrides the per-theme default.
 *
 * Both helpers fall back to safe defaults so a missing or unknown
 * value never breaks render. Defaults match Ahmad's 2026-05-16
 * "smaller" preference (sm category, sm product).
 */
import type { CardAspect, CardGap, CardShape, CardSize } from '@force/shared';

/**
 * Category card size → tailwind max-w classes (mobile + desktop).
 * The cap is what visually shrinks/grows the card; aspect ratio is
 * controlled separately via `categoryAspectClass`.
 */
export function categorySizeClass(size: CardSize | undefined): string {
  switch (size) {
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
      return 'gap-1.5 sm:gap-2';
    case 'loose':
      return 'gap-5 sm:gap-6';
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
 * Optional per-card "framed" wrapper. When the merchant turns on
 * `showCardFrame` in admin, each category / product card sits inside a
 * rounded-2xl + bg-card + subtle shadow frame. Returns `''` when off so
 * the wrapper renders as a no-op div (template stays the same). Used by
 * CategoryStrip, per-theme CategoryGrid, and ProductCarousel. Added
 * 2026-05-17 night (Ahmad: "opt-in frames around categories + products").
 */
export function cardFrameClass(on: boolean | undefined): string {
  return on
    ? 'rounded-2xl border border-border bg-card p-3 shadow-sm transition-shadow duration-300 hover:shadow-md'
    : '';
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
