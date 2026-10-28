import Link from '../../components/StoreLink';
import type { CSSProperties } from 'react';
import { pickReadableForeground } from '@ebda/shared';

/**
 * A hero with NO photo (STOP-2 taste audit, fresh stores): the full-bleed legacy hero used to paint
 * a screen-high empty block with the store's name in it. Without an image the hero is a compact
 * title band instead: the name as the page's h1 in the display face, the merchant's subtitle if
 * any, one call to action, and a primary hairline underneath. Token colours only; the name is the
 * merchant's own `name` (never a slug, see tests/unit/no-slug-as-display-name.test.ts).
 *
 * `bg` is the resolved colour the hero wrapper paints (the Smart Palette sets `hero.bgColor` to
 * `token:primary`, a light moon silver on Lookbook): the title, subtitle and button then take the
 * WCAG-readable ink for THAT surface instead of the page ink, which was 1.2:1 on it (found by the
 * Qamar look matrix on `qamar-one`, an `h1` axe `color-contrast` failure). No `bg` (the page
 * shows through, or the inverse band swapped the ink variables itself): token inks as before.
 */
export function CompactHeroBand({
  title,
  subtitle,
  ctaText,
  ctaLink,
  bg,
}: {
  title: string;
  subtitle?: string;
  ctaText: string;
  ctaLink: string;
  bg?: string;
}) {
  const ink = pickReadableForeground(bg);
  const onBg: CSSProperties | undefined = ink ? { color: ink } : undefined;
  const ctaOnBg: CSSProperties | undefined = ink ? { backgroundColor: ink, color: bg } : undefined;
  return (
    <section
      data-hero="compact"
      className="border-b border-primary/50 px-4 py-8 sm:px-6 sm:py-10 lg:px-8"
    >
      <div className="mx-auto flex max-w-7xl flex-col items-start gap-3">
        <h1
          className="font-display text-3xl leading-tight text-foreground sm:text-4xl rtl:leading-[1.45]"
          style={onBg}
        >
          {title}
        </h1>
        {subtitle && (
          <p className="max-w-prose text-base text-muted-foreground" style={onBg}>
            {subtitle}
          </p>
        )}
        <Link
          href={ctaLink}
          style={ctaOnBg}
          className="inline-flex min-h-11 items-center rounded-[var(--radius)] bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {ctaText}
        </Link>
      </div>
    </section>
  );
}
