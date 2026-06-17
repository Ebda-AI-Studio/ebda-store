import type { SectionPaddingMaxWidthVisibility } from '@force/shared';

/**
 * Padding-top preset → Tailwind class.
 * Default (undefined) keeps the baseline `py-*` the section already applies
 * (caller must NOT add the baseline when paddingTop is explicitly set, else
 * both stack). Map matches the admin SectionPaddingMaxWidthBlock labels and
 * the `SectionPaddingMaxWidthVisibility` type in @force/shared.
 *
 * Scale chosen to mirror the existing `py-12 sm:py-16 lg:py-20` baseline
 * (= 'normal') with proportional steps above and below.
 */
const PADDING_TOP_CLASSES: Record<
  NonNullable<SectionPaddingMaxWidthVisibility['paddingTop']>,
  string
> = {
  none: 'pt-0',
  tight: 'pt-4 sm:pt-6 lg:pt-8',
  normal: 'pt-12 sm:pt-16 lg:pt-20',
  loose: 'pt-16 sm:pt-20 lg:pt-28',
  xloose: 'pt-24 sm:pt-28 lg:pt-36',
};

const PADDING_BOTTOM_CLASSES: Record<
  NonNullable<SectionPaddingMaxWidthVisibility['paddingBottom']>,
  string
> = {
  none: 'pb-0',
  tight: 'pb-4 sm:pb-6 lg:pb-8',
  normal: 'pb-12 sm:pb-16 lg:pb-20',
  loose: 'pb-16 sm:pb-20 lg:pb-28',
  xloose: 'pb-24 sm:pb-28 lg:pb-36',
};

/**
 * Visibility class for the outer section wrapper.
 *   hideOnMobile: hidden on <768 px, shown on ≥768 px → `hidden md:block`
 *   hideOnDesktop: shown on <768 px, hidden on ≥768 px → `md:hidden`
 *   Both true: hidden everywhere → `hidden` (degenerate; merchant mistake)
 *
 * Returns '' when neither flag is set (no change from default).
 */
function visibilityClass(s: SectionPaddingMaxWidthVisibility): string {
  if (s.hideOnMobile && s.hideOnDesktop) return 'hidden';
  if (s.hideOnMobile) return 'hidden md:block';
  if (s.hideOnDesktop) return 'md:hidden';
  return '';
}

/**
 * Returns className tokens derived from `SectionPaddingMaxWidthVisibility`
 * to be merged onto the outer `<section>` (or `<div>`) wrapper.
 *
 * **Usage:**
 * ```tsx
 * const { wrapperClass, innerContainerClass } = sectionSpacingClasses(layout.hero);
 *
 * // On the outer <section> (replaces or augments the baseline py-* classes):
 * <section className={`bg-[hsl(var(--bg-page))] ${wrapperClass}`}>
 *   // On the inner max-w container (replaces the baseline max-w-7xl when maxWidth='full'):
 *   <div className={innerContainerClass}>…</div>
 * </section>
 * ```
 *
 * **Unset semantics (zero regression):**
 * When none of the five fields are set the function returns the same classes
 * you would have written by hand — `wrapperClass` matches the baseline
 * `py-12 sm:py-16 lg:py-20`, `innerContainerClass` matches `mx-auto
 * max-w-7xl px-4 sm:px-6 lg:px-8` — so callers that always apply the
 * return value need no `if (field) { … } else { … }` guard.
 *
 * **maxWidth semantics:**
 * - `'contained'` (or unset) → `mx-auto max-w-7xl px-4 sm:px-6 lg:px-8`
 *   (matches the site-wide container used everywhere).
 * - `'full'` → `w-full` (edge-to-edge, no horizontal padding cap; the
 *   inner component is responsible for its own content gutter if needed).
 *
 * @param s - The `SectionPaddingMaxWidthVisibility` partial from layout settings.
 *            May be `undefined` when the section's optional layout key hasn't
 *            been set yet; the function falls back to defaults throughout.
 */
export function sectionSpacingClasses(s: SectionPaddingMaxWidthVisibility | undefined): {
  /** Classes to apply on the outermost `<section>` / `<div>` wrapper.
   *  Includes visibility + vertical padding. */
  wrapperClass: string;
  /** Classes for the inner max-width container `<div>`. */
  innerContainerClass: string;
} {
  if (!s) {
    return {
      wrapperClass: 'py-12 sm:py-16 lg:py-20',
      innerContainerClass: 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8',
    };
  }

  // Padding: use explicit preset when set; fall back to 'normal' baseline.
  const ptClass = s.paddingTop ? PADDING_TOP_CLASSES[s.paddingTop] : 'pt-12 sm:pt-16 lg:pt-20';
  const pbClass = s.paddingBottom
    ? PADDING_BOTTOM_CLASSES[s.paddingBottom]
    : 'pb-12 sm:pb-16 lg:pb-20';

  // Visibility
  const vis = visibilityClass(s);

  const wrapperClass = [ptClass, pbClass, vis].filter(Boolean).join(' ');

  // Max-width container
  const innerContainerClass =
    s.maxWidth === 'full' ? 'w-full' : 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8';

  return { wrapperClass, innerContainerClass };
}

/**
 * Convenience wrapper: returns just the wrapper class string.
 * Avoids destructuring noise when the caller only needs the outer section
 * padding/visibility and doesn't control the inner container.
 */
export function sectionWrapperClass(s: SectionPaddingMaxWidthVisibility | undefined): string {
  return sectionSpacingClasses(s).wrapperClass;
}

/**
 * Returns only the breakpoint visibility class for a section.
 * Use this when the section manages its own internal padding/layout
 * (e.g. the hero, which has its own aspect-ratio-driven height) and
 * you only want to apply `hideOnMobile` / `hideOnDesktop`.
 *
 * Returns `undefined` when neither visibility flag is set (no class needed).
 */
export function sectionVisibilityClass(
  s: SectionPaddingMaxWidthVisibility | undefined
): string | undefined {
  if (!s) return undefined;
  if (s.hideOnMobile && s.hideOnDesktop) return 'hidden';
  if (s.hideOnMobile) return 'hidden md:block';
  if (s.hideOnDesktop) return 'md:hidden';
  return undefined;
}
