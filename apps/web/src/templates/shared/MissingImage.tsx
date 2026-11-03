import type { ReactNode } from 'react';

/**
 * Designed fallback for a product / category / PDP slot with no photo (storefront audit
 * 2026-11-03 #5, Ruling PREMIUM-5). Replaces the grey letter circle, the 40px hairline icon and
 * the grey disc + cube.
 *
 * Painted ONLY from the store's own tokens, so it follows every look, merchant colour and
 * section band (the section tone contract re-scopes the tokens): a ground of `--muted` with a
 * wash of the brand colour, a fine diagonal hatch in the foreground at 5%, and the first letter
 * of the name set large in the display font at low opacity. Never Ebda's girih (that is the
 * Ebda marketing look's own motif, not a merchant's). Decorative: aria-hidden; the name next to
 * it is the accessible label. Fills its parent (`absolute inset-0` when the parent is
 * `relative`), so it never changes layout.
 */
export function monogramOf(name: string | undefined | null): string {
  const s = (name ?? '').trim();
  if (!s) return '';
  const Seg = (
    Intl as unknown as {
      Segmenter?: new (
        l?: string,
        o?: object
      ) => { segment(s: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  const first = Seg
    ? [...new Seg(undefined, { granularity: 'grapheme' }).segment(s)][0]?.segment
    : Array.from(s)[0];
  return (first ?? '').toLocaleUpperCase();
}

export function MissingImage({
  label,
  size = 'md',
  className = '',
  children,
}: {
  /** The product or category name; its first letter becomes the monogram. */
  label?: string | null;
  /** `lg` for the PDP gallery; `sm` for list thumbs / search rows. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children?: ReactNode;
}) {
  const letter = monogramOf(label);
  const text = size === 'lg' ? 'text-[9rem]' : size === 'sm' ? 'text-2xl' : 'text-6xl';
  return (
    <div
      aria-hidden="true"
      data-missing-image=""
      className={`absolute inset-0 flex items-center justify-center overflow-hidden bg-muted ${className}`}
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(135deg, hsl(var(--primary) / 0.14), hsl(var(--primary) / 0.03) 60%), repeating-linear-gradient(45deg, hsl(var(--foreground) / 0.05) 0 1px, transparent 1px 12px)',
        }}
      />
      {letter && (
        // The letter is painted by CSS (`attr()`), not a text node: it is decoration, so it must not
        // leak into the parent's textContent (search rows, link names, tests that read them).
        <span
          data-monogram={letter}
          className={`relative select-none leading-none text-primary/20 before:content-[attr(data-monogram)] ${text}`}
          style={{ fontFamily: 'var(--font-display, inherit)' }}
        />
      )}
      {children}
    </div>
  );
}
