import {
  getLook,
  type SectionPaddingMaxWidthVisibility,
  type SectionSpacingPreset,
  type Viewport,
} from '@ebda/shared';

/**
 * Padding-top preset → Tailwind class.
 * Default (undefined) keeps the baseline `py-*` the section already applies
 * (caller must NOT add the baseline when paddingTop is explicitly set, else
 * both stack). Map matches the admin SectionPaddingMaxWidthBlock labels and
 * the `SectionPaddingMaxWidthVisibility` type in @ebda/shared.
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
  xxloose: 'pt-28 sm:pt-36 lg:pt-44',
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
  xxloose: 'pb-28 sm:pb-36 lg:pb-44',
};

/**
 * Per-device spacing (editor Ruling SP-1). Once an axis carries a tablet or mobile value it is
 * emitted for all three devices as plain literals (Tailwind's JIT must see every class), with no
 * `sm:` step, so nothing competes: mobile < 768 · tablet 768-1023 · desktop >= 1024.
 * Rows follow SECTION_SPACING_PRESETS (none, tight, normal, loose, xloose, xxloose); the values
 * are `SECTION_SPACING_PX / 4`, pinned by `tests/unit/section-spacing-device.test.ts`.
 */
export const DEVICE_SPACING_CLASSES = {
  pt: {
    mobile: [
      'max-md:pt-0',
      'max-md:pt-4',
      'max-md:pt-12',
      'max-md:pt-16',
      'max-md:pt-24',
      'max-md:pt-28',
    ],
    tablet: [
      'md:max-lg:pt-0',
      'md:max-lg:pt-6',
      'md:max-lg:pt-16',
      'md:max-lg:pt-20',
      'md:max-lg:pt-28',
      'md:max-lg:pt-36',
    ],
    desktop: ['lg:pt-0', 'lg:pt-8', 'lg:pt-20', 'lg:pt-28', 'lg:pt-36', 'lg:pt-44'],
  },
  pb: {
    mobile: [
      'max-md:pb-0',
      'max-md:pb-4',
      'max-md:pb-12',
      'max-md:pb-16',
      'max-md:pb-24',
      'max-md:pb-28',
    ],
    tablet: [
      'md:max-lg:pb-0',
      'md:max-lg:pb-6',
      'md:max-lg:pb-16',
      'md:max-lg:pb-20',
      'md:max-lg:pb-28',
      'md:max-lg:pb-36',
    ],
    desktop: ['lg:pb-0', 'lg:pb-8', 'lg:pb-20', 'lg:pb-28', 'lg:pb-36', 'lg:pb-44'],
  },
  mt: {
    mobile: [
      'max-md:mt-0',
      'max-md:mt-4',
      'max-md:mt-12',
      'max-md:mt-16',
      'max-md:mt-24',
      'max-md:mt-28',
    ],
    tablet: [
      'md:max-lg:mt-0',
      'md:max-lg:mt-6',
      'md:max-lg:mt-16',
      'md:max-lg:mt-20',
      'md:max-lg:mt-28',
      'md:max-lg:mt-36',
    ],
    desktop: ['lg:mt-0', 'lg:mt-8', 'lg:mt-20', 'lg:mt-28', 'lg:mt-36', 'lg:mt-44'],
  },
  mb: {
    mobile: [
      'max-md:mb-0',
      'max-md:mb-4',
      'max-md:mb-12',
      'max-md:mb-16',
      'max-md:mb-24',
      'max-md:mb-28',
    ],
    tablet: [
      'md:max-lg:mb-0',
      'md:max-lg:mb-6',
      'md:max-lg:mb-16',
      'md:max-lg:mb-20',
      'md:max-lg:mb-28',
      'md:max-lg:mb-36',
    ],
    desktop: ['lg:mb-0', 'lg:mb-8', 'lg:mb-20', 'lg:mb-28', 'lg:mb-36', 'lg:mb-44'],
  },
} as const satisfies Record<string, Record<Viewport, readonly string[]>>;

// Same steps as the padding maps above, as literal margin classes (Tailwind's JIT cannot see a
// class built from a string).
const MARGIN_TOP_CLASSES: Record<SectionSpacingPreset, string> = {
  none: 'mt-0',
  tight: 'mt-4 sm:mt-6 lg:mt-8',
  normal: 'mt-12 sm:mt-16 lg:mt-20',
  loose: 'mt-16 sm:mt-20 lg:mt-28',
  xloose: 'mt-24 sm:mt-28 lg:mt-36',
  xxloose: 'mt-28 sm:mt-36 lg:mt-44',
};
const MARGIN_BOTTOM_CLASSES: Record<SectionSpacingPreset, string> = {
  none: 'mb-0',
  tight: 'mb-4 sm:mb-6 lg:mb-8',
  normal: 'mb-12 sm:mb-16 lg:mb-20',
  loose: 'mb-16 sm:mb-20 lg:mb-28',
  xloose: 'mb-24 sm:mb-28 lg:mb-36',
  xxloose: 'mb-28 sm:mb-36 lg:mb-44',
};

const PRESET_INDEX: Record<SectionSpacingPreset, number> = {
  none: 0,
  tight: 1,
  normal: 2,
  loose: 3,
  xloose: 4,
  xxloose: 5,
};
const DEVICES: readonly Viewport[] = ['mobile', 'tablet', 'desktop'];

type SpacingInput = Partial<SectionPaddingMaxWidthVisibility> | undefined;

/** True when `axis` carries a tablet or mobile value. */
function axisIsPerDevice(s: SpacingInput, axis: 'Top' | 'Bottom'): boolean {
  return !!s && !!(s[`padding${axis}Tablet`] || s[`padding${axis}Mobile`]);
}

/**
 * The three device classes for one axis. Resolution per device: device value, else the base value,
 * else `fallback` (padding: the baseline `normal`; hero margin: `none`).
 */
function deviceAxisClasses(
  s: NonNullable<SpacingInput>,
  axis: 'Top' | 'Bottom',
  prefix: 'pt' | 'pb' | 'mt' | 'mb',
  fallback: SectionSpacingPreset
): string {
  const base = s[`padding${axis}`];
  return DEVICES.map(v => {
    const device =
      v === 'desktop' ? undefined : s[`padding${axis}${v === 'tablet' ? 'Tablet' : 'Mobile'}`];
    return DEVICE_SPACING_CLASSES[prefix][v][PRESET_INDEX[device ?? base ?? fallback]];
  }).join(' ');
}

/**
 * Outer margin classes for a section that lays out its own height (the hero, Ruling SP-3).
 * Unset on both an axis and every device = nothing, so an untouched hero is unchanged.
 */
export function sectionMarginClasses(s: SpacingInput): string {
  if (!s) return '';
  const out: string[] = [];
  for (const [axis, prefix, base, single] of [
    ['Top', 'mt', MARGIN_TOP_CLASSES, s.paddingTop],
    ['Bottom', 'mb', MARGIN_BOTTOM_CLASSES, s.paddingBottom],
  ] as const) {
    if (axisIsPerDevice(s, axis)) out.push(deviceAxisClasses(s, axis, prefix, 'none'));
    else if (single) out.push(base[single]);
  }
  return out.join(' ');
}

/**
 * Visibility class for the outer section wrapper.
 *   hideOnMobile: hidden on <768 px, shown on ≥768 px → `hidden md:block`
 *   hideOnDesktop: shown on <768 px, hidden on ≥768 px → `md:hidden`
 *   Both true: hidden everywhere → `hidden` (degenerate; merchant mistake)
 *
 * Returns '' when neither flag is set (no change from default).
 */
/**
 * Three-viewport visibility (visual builder, BUILDER-PREVIEW-1). Only used
 * when `hideOnTablet` is set; otherwise the legacy two-way classes below are
 * emitted unchanged, so no existing store's markup moves.
 * mobile < 768 · tablet 768–1023 · desktop >= 1024.
 */
function threeWayVisibilityClass(s: SectionPaddingMaxWidthVisibility): string {
  return [
    s.hideOnMobile ? 'max-md:hidden' : '',
    s.hideOnTablet ? 'md:max-lg:hidden' : '',
    s.hideOnDesktop ? 'lg:hidden' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function visibilityClass(s: SectionPaddingMaxWidthVisibility): string {
  if (s.hideOnTablet !== undefined) return threeWayVisibilityClass(s);
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
 * const { wrapperClass, innerContainerClass } = sectionSpacingClasses(layout.hero, store.look);
 *
 * // `store.look` (optional) marks UNSET padding axes so a look's --space-unit can scale them;
 * // omit it and the output is the legacy class list.
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
export function sectionSpacingClasses(
  s: SectionPaddingMaxWidthVisibility | undefined,
  /** The store's look id. When it names a valid look, the UNSET (default) padding axes get
   *  `sp-top-default` / `sp-bottom-default` so globals.css can scale them by --space-unit.
   *  An explicit preset (even "normal") never gets a marker (Ruling LOOKS-3); no look = no marker. */
  look?: string | null
): {
  /** Classes to apply on the outermost `<section>` / `<div>` wrapper.
   *  Includes visibility + vertical padding. */
  wrapperClass: string;
  /** Classes for the inner max-width container `<div>`. */
  innerContainerClass: string;
} {
  const mark = getLook(look) !== undefined;
  if (!s) {
    return {
      wrapperClass: mark
        ? 'py-12 sm:py-16 lg:py-20 sp-top-default sp-bottom-default'
        : 'py-12 sm:py-16 lg:py-20',
      innerContainerClass: 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8',
    };
  }

  // Padding: use explicit preset when set; fall back to 'normal' baseline. An axis with a tablet /
  // mobile value is emitted per device (Ruling SP-1), without the look's density marker (SP-2).
  const topPerDevice = axisIsPerDevice(s, 'Top');
  const bottomPerDevice = axisIsPerDevice(s, 'Bottom');
  const ptClass = topPerDevice
    ? deviceAxisClasses(s, 'Top', 'pt', 'normal')
    : s.paddingTop
      ? PADDING_TOP_CLASSES[s.paddingTop]
      : 'pt-12 sm:pt-16 lg:pt-20';
  const pbClass = bottomPerDevice
    ? deviceAxisClasses(s, 'Bottom', 'pb', 'normal')
    : s.paddingBottom
      ? PADDING_BOTTOM_CLASSES[s.paddingBottom]
      : 'pb-12 sm:pb-16 lg:pb-20';

  // Visibility
  const vis = visibilityClass(s);

  const wrapperClass = [
    ptClass,
    pbClass,
    mark && !s.paddingTop && !topPerDevice ? 'sp-top-default' : '',
    mark && !s.paddingBottom && !bottomPerDevice ? 'sp-bottom-default' : '',
    vis,
  ]
    .filter(Boolean)
    .join(' ');

  // Max-width container
  const innerContainerClass =
    s.maxWidth === 'full' ? 'w-full' : 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8';

  return { wrapperClass, innerContainerClass };
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
  if (s.hideOnTablet !== undefined) return threeWayVisibilityClass(s) || undefined;
  if (s.hideOnMobile && s.hideOnDesktop) return 'hidden';
  if (s.hideOnMobile) return 'hidden md:block';
  if (s.hideOnDesktop) return 'md:hidden';
  return undefined;
}
