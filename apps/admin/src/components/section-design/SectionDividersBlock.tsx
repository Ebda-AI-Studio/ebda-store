'use client';

/**
 * Per-section dividers block (5 divider slots with one shared style) and the small controls it uses.
 * Shared by the form page builder and the visual editor's settings panel.
 */
import { useT } from '@/i18n/useT';
import { ColorField } from '../ColorField';
import { Toggle } from '../Toggle';

export function RowToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <span className="text-foreground">{label}</span>
      <Toggle checked={checked} onChange={onChange} />
    </label>
  );
}

/**
 * Bundled controls for kicker + subtitle text (bilingual) AND the two
 * line-divider toggles that surround them (Ahmad 2026-05-17 night —
 * extracted from the inline Categories block so newArrivals + bestSellers
 * get the same surface). `showKickerLines` / `showSubtitleLines` default
 * to true (lines visible) and only affect rendering paths that use the
 * shared `SectionHeading` component (ProductCarousel + CategoryStrip).
 * Per-theme `CategoryGrid` paths render their own chip-style heading
 * which doesn't have flanking lines — toggles are a no-op there.
 */
export type KickerSubtitleValues = {
  kicker?: string;
  kickerAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  title?: string;
  titleAr?: string;
  /** @deprecated 2026-05-20 — use `dividers.kicker.enabled`. Still read as fallback. */
  showKickerLines?: boolean;
  /** @deprecated 2026-05-20 — use `dividers.subtitle.enabled`. Still read as fallback. */
  showSubtitleLines?: boolean;
  /** Per-section divider slots (above / kicker / title / subtitle / belowHeading). */
  dividers?: import('@ebda/shared').SectionDividers;
};

export type DividerSlot = 'above' | 'kicker' | 'title' | 'subtitle' | 'belowHeading';

export function SectionDividersBlock({
  values,
  onPatch,
  availableSlots,
  theme,
}: {
  values: KickerSubtitleValues;
  onPatch: (patch: Partial<KickerSubtitleValues>) => void;
  /** Which of the 5 slots to expose for this section. Default: all 5.
   *  Sections without a SectionHeading (Header / Footer / Announcement /
   *  Brand Story / Trust Strip / Blog Carousel) restrict to ['above',
   *  'belowHeading'] only — the kicker/title/subtitle toggles would be
   *  decorative because those sections don't render a heading with those
   *  parts. Audit fix Ahmad 2026-05-20. */
  availableSlots?: DividerSlot[];
  /** Resolved store theme — needed for the ColorField when color === 'custom'
   *  so the brand-token dropdown can resolve primary/accent/etc + show the
   *  contrast preview. Optional (pre-existing callsites without theme still
   *  work, just without contrast preview). */
  theme?: import('@ebda/shared').StoreTheme;
}) {
  const t = useT('orders.layout');
  const dividers = values.dividers ?? {};

  // Slot toggles. When turning ON, seed `enabled: true` while preserving any
  // existing styling fields. When OFF, mark explicit `enabled: false` so the
  // storefront doesn't fall back to the legacy boolean.
  function setSlot(slot: 'above' | 'kicker' | 'title' | 'subtitle' | 'belowHeading', on: boolean) {
    // When ENABLING a slot, seed it with the section's shared divider styling
    // (colour / style / thickness / width / spacing) so a slot turned ON after
    // the colour was picked still inherits it. Without this, "Around title"
    // (default OFF) was saved as `{ enabled: true }` only and the storefront
    // rendered the default foreground hairline instead of the merchant's colour
    // — the exact "around title do not take the color i picked" report
    // (Ahmad 2026-06-04). The storefront also has a render-time fallback for
    // already-saved stores; this keeps newly-saved data self-consistent.
    const styleSrc = on
      ? (dividers.above ??
        dividers.kicker ??
        dividers.title ??
        dividers.subtitle ??
        dividers.belowHeading)
      : undefined;
    const styleSeed: Partial<import('@ebda/shared').DividerSettings> = styleSrc
      ? {
          style: styleSrc.style,
          thickness: styleSrc.thickness,
          width: styleSrc.width,
          color: styleSrc.color,
          customColor: styleSrc.customColor,
          spacing: styleSrc.spacing,
        }
      : {};
    onPatch({
      dividers: {
        ...dividers,
        [slot]: { ...styleSeed, ...(dividers[slot] ?? {}), enabled: on },
      },
    });
  }

  // Resolve current ENABLED state per slot. Kicker / subtitle fall back
  // to the legacy showKickerLines / showSubtitleLines booleans (default
  // true) when the new shape is unset, matching storefront behavior.
  const aboveOn = dividers.above?.enabled === true;
  const kickerOn = dividers.kicker?.enabled ?? values.showKickerLines !== false;
  const titleOn = dividers.title?.enabled === true;
  const subtitleOn = dividers.subtitle?.enabled ?? values.showSubtitleLines !== false;
  const belowHeadingOn = dividers.belowHeading?.enabled === true;
  const anyOn = aboveOn || kickerOn || titleOn || subtitleOn || belowHeadingOn;

  // Shared styling: one set of style/thickness/width/color/spacing applied to
  // every enabled slot in this section. Reads from above slot's styling as
  // the canonical source (falls back to next enabled slot, then defaults).
  // Writing fans out the change to ALL enabled slots so they stay in sync.
  const styleSource: Partial<import('@ebda/shared').DividerSettings> =
    dividers.above ??
    dividers.kicker ??
    dividers.title ??
    dividers.subtitle ??
    dividers.belowHeading ??
    {};
  const sharedStyle = styleSource.style ?? 'solid';
  const sharedThickness = styleSource.thickness ?? 1;
  const sharedWidth = styleSource.width ?? 'short';
  const sharedColor = styleSource.color ?? 'foreground';
  const sharedCustomColor = styleSource.customColor ?? '#cccccc';
  const sharedSpacing = styleSource.spacing ?? 'normal';

  function patchSharedStyle(patch: Partial<import('@ebda/shared').DividerSettings>) {
    const slots = ['above', 'kicker', 'title', 'subtitle', 'belowHeading'] as const;
    const next: typeof dividers = { ...dividers };
    for (const slot of slots) {
      const existing = dividers[slot];
      if (!existing) continue; // skip slots that have never been touched
      next[slot] = { ...existing, ...patch };
    }
    onPatch({ dividers: next });
  }

  return (
    <div className="mt-3 rounded-lg border border-dashed border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('dividers.title')}
      </p>
      <p className="mb-3 text-xs text-muted-foreground/80">{t('dividers.hint')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(!availableSlots || availableSlots.includes('above')) && (
          <RowToggle
            label={t('dividers.above')}
            checked={aboveOn}
            onChange={v => setSlot('above', v)}
          />
        )}
        {(!availableSlots || availableSlots.includes('kicker')) && (
          <RowToggle
            label={t('dividers.aroundKicker')}
            checked={kickerOn}
            onChange={v => setSlot('kicker', v)}
          />
        )}
        {(!availableSlots || availableSlots.includes('title')) && (
          <RowToggle
            label={t('dividers.aroundTitle')}
            checked={titleOn}
            onChange={v => setSlot('title', v)}
          />
        )}
        {(!availableSlots || availableSlots.includes('subtitle')) && (
          <RowToggle
            label={t('dividers.aroundSubtitle')}
            checked={subtitleOn}
            onChange={v => setSlot('subtitle', v)}
          />
        )}
        {(!availableSlots || availableSlots.includes('belowHeading')) && (
          <RowToggle
            label={t('dividers.belowHeading')}
            checked={belowHeadingOn}
            onChange={v => setSlot('belowHeading', v)}
          />
        )}
      </div>

      {anyOn && (
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-5">
          <DividerStyleSelect
            label={t('dividers.style')}
            value={sharedStyle}
            options={[
              ['solid', t('dividers.optSolid')],
              ['dashed', t('dividers.optDashed')],
              ['dotted', t('dividers.optDotted')],
              ['double', t('dividers.optDouble')],
            ]}
            onChange={v => patchSharedStyle({ style: v as 'solid' })}
          />
          <DividerStyleSelect
            label={t('dividers.thickness')}
            value={String(sharedThickness)}
            options={[
              ['1', '1px'],
              ['2', '2px'],
              ['3', '3px'],
            ]}
            onChange={v => patchSharedStyle({ thickness: Number(v) as 1 | 2 | 3 })}
          />
          <DividerStyleSelect
            label={t('dividers.width')}
            value={sharedWidth}
            options={[
              ['short', t('dividers.optShort')],
              ['contained', t('dividers.optContained')],
              ['full', t('dividers.optEdgeToEdge')],
            ]}
            onChange={v => patchSharedStyle({ width: v as 'short' })}
          />
          <div className="flex flex-col gap-1 sm:col-span-2">
            <DividerStyleSelect
              label={t('dividers.color')}
              value={sharedColor}
              options={[
                ['auto', t('dividers.colorAuto')],
                ['foreground', t('dividers.colorForeground')],
                ['accent', t('dividers.colorAccent')],
                ['custom', t('dividers.colorCustom')],
              ]}
              onChange={v => patchSharedStyle({ color: v as 'auto' })}
            />
            {sharedColor === 'custom' && (
              // 2026-05-20: replaced the tiny inline color input with the
              // proper ColorField — gives merchants the brand-token dropdown
              // (primary / secondary / accent / card / muted / foreground /
              // background / border / etc) AND a full-size hex picker AND a
              // contrast preview. Same component used by every other color
              // field in the editor.
              <ColorField
                label=""
                value={sharedCustomColor}
                // Persist `color: 'custom'` WITH the customColor so the
                // storefront resolver honours the pick. Writing customColor
                // alone left `color` defaulting to 'foreground', which ignored
                // the pick and rendered the grey hairline (Ebda Store 2026-06-04).
                onChange={v => patchSharedStyle({ customColor: v || undefined, color: 'custom' })}
                theme={theme}
              />
            )}
          </div>
          <DividerStyleSelect
            label={t('dividers.spacing')}
            value={sharedSpacing}
            options={[
              ['tight', t('paddingBlock.optTight')],
              ['normal', t('paddingBlock.optNormal')],
              ['loose', t('paddingBlock.optLoose')],
            ]}
            onChange={v => patchSharedStyle({ spacing: v as 'tight' })}
          />
        </div>
      )}
    </div>
  );
}

/** Tiny labelled native select for the shared divider style controls. */
export function DividerStyleSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
