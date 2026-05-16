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
import type { CardAspect, CardSize } from '@force/shared';

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
