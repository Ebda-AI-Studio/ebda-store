import { cn } from '../utils/cn';

export interface CartIconProps {
  /** Tailwind classes forwarded to the <svg> element (sizing, color, etc.) */
  className?: string;
  /** SVG stroke width — call sites use 1, 1.5, or 2. Defaults to 2. */
  strokeWidth?: number;
  /** Marks the icon as decorative. Pass true or "true" to hide from AT. */
  'aria-hidden'?: boolean | 'true' | 'false';
}

/**
 * Shared shopping-cart-on-wheels icon extracted from ~15 inline SVG copies
 * across apps/web and apps/admin. Both apps depend on @force/ui so this is
 * the single source of truth for the canonical cart glyph.
 *
 * Canonical path (commit e6ae439):
 * M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184
 *  1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z
 */
export function CartIcon({ className, strokeWidth = 2, 'aria-hidden': ariaHidden }: CartIconProps) {
  return (
    <svg
      className={cn(className)}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      aria-hidden={ariaHidden}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
      />
    </svg>
  );
}
