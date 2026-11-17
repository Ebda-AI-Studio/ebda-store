'use client';

import { Button } from '@/components/ui/Button';
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ZoneOverride, StoreTheme, ColorToken } from '@ebda/shared';
import { ColorField } from './ColorField';
import { Disclosure } from './ui/Disclosure';
import { Field, Segmented, TextInput, type SegmentOption } from './ui/Field';
import { FontPicker, type PickerFont } from './section-design/FontPicker';
import { useT } from '@/i18n/useT';

export interface ZoneEditorProps {
  /** Unique key identifying the zone (e.g. 'sectionHeading', 'kicker'). Used as label prefix. */
  zoneKey: string;
  /** Human-readable label shown as section heading. */
  zoneLabel: string;
  /** Current values for this zone override. */
  values: ZoneOverride;
  /**
   * Resolved zone the merchant is inheriting from — shown as faded placeholder text
   * when values is empty (e.g. the global typography zone for this role).
   */
  placeholder?: ZoneOverride;
  /** Called whenever any field changes. Receives the full merged update. */
  onChange: (next: Partial<ZoneOverride>) => void;
  /**
   * When provided AND any value is set, renders a small "Reset to default" link
   * at the bottom of the editor block.
   */
  onReset?: () => void;
  /**
   * Required for the embedded ColorField brand-token dropdown + contrast preview.
   * Pass `undefined` to hide the color field entirely (use `renderColorField` instead).
   */
  theme: StoreTheme | undefined;
  /**
   * Optional render prop to replace the default ColorField with a custom color UI.
   * Used by the legacy typography page which has its own brand-preset format.
   * When provided the default ColorField is NOT rendered.
   */
  renderColorField?: () => ReactNode;
  /**
   * When provided, renders the font family field as a `<select>` instead of a
   * free-form `<input type="text">`. Pass the full option list including the
   * "Inherit" placeholder option. Used by the legacy typography page which has
   * a curated font library the merchant loads first.
   */
  fontFamilyOptions?: Array<{ value: string; label: string }>;
  /**
   * When true, the internal label heading row is not rendered. Use when the
   * parent already renders a heading for the zone (e.g. the legacy typography
   * page wraps each ZoneEditor inside a zone block that already has an h3).
   */
  hideLabel?: boolean;
  /**
   * Override the outer container className. When omitted the component renders
   * with its own border + padding. Pass `""` or a custom className to suppress
   * the default border when the parent already provides one (e.g. legacy
   * typography page's per-zone data-zone-block).
   */
  className?: string;
  /**
   * When the merchant has not set a color for this zone yet, show the inherited
   * brand-token color as the empty-state hint in the ColorField dropdown.
   * Passed through directly to the embedded `<ColorField inheritFromToken>`.
   * Omit when the zone's text doesn't inherit from a predictable brand token.
   */
  inheritFromToken?: ColorToken;
  /**
   * The store's font library. When given (and no `fontFamilyOptions`), the font field is the FontPicker:
   * each family listed in its own face. Without it the field stays a plain text input (legacy callers).
   */
  fonts?: PickerFont[];
}

// Auto-append `px` to bare numbers in size / spacing fields so merchants
// can type "16" and get "16px" rather than an invalid CSS value.
function normaliseSizeValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
  return trimmed;
}

// Determine whether the ZoneOverride has any non-empty values set.
function hasAnyValue(v: ZoneOverride): boolean {
  return Object.values(v).some(f => typeof f === 'string' && f.trim().length > 0);
}

/**
 * Per-zone typography override editor.
 *
 * Renders controls for the six fields of `ZoneOverride` (fontFamily, fontSize,
 * fontWeight, color, letterSpacing, lineHeight) plus a textTransform select.
 * When `placeholder` is provided, each empty field shows the inherited value as
 * a faded hint via the input's `placeholder` attribute.
 * When `onReset` is provided and any field is set, a small "Reset to default"
 * link appears at the bottom.
 *
 * Designed to work in two contexts:
 *   1. Per-section typography overrides inside the editor's section panels.
 *   2. The "Default typography" SectionCard in the editor's Theme pane that
 *      mirrors the global zones from the old /typography admin page.
 */
export function ZoneEditor({
  zoneKey,
  zoneLabel,
  values,
  placeholder,
  onChange,
  onReset,
  theme,
  renderColorField,
  fontFamilyOptions,
  hideLabel,
  className,
  inheritFromToken,
  fonts,
}: ZoneEditorProps) {
  const t = useT('zoneEditor');
  const hasValues = hasAnyValue(values);
  // UX:C-3 - inline feedback instead of a native alert().
  const [sizeRejected, setSizeRejected] = useState(false);

  const handleSize = (field: 'fontSize' | 'letterSpacing' | 'lineHeight', raw: string) => {
    if (field === 'fontSize') setSizeRejected(false);
    onChange({ [field]: normaliseSizeValue(raw) });
  };

  /** Named options + the merchant's current value when it is none of them (never lose a stored value). */
  const withCurrent = (opts: SegmentOption[], cur: string | undefined): SegmentOption[] =>
    cur && !opts.some(o => o.value === cur) ? [...opts, { value: cur, label: cur }] : opts;
  const same: SegmentOption = { value: '', label: t('same') };

  const sizeOptions = withCurrent(
    [
      same,
      { value: '14px', label: t('sizeNames.small') },
      { value: '16px', label: t('sizeNames.normal') },
      { value: '18px', label: t('sizeNames.large') },
      { value: '22px', label: t('sizeNames.title') },
    ],
    values.fontSize
  );
  const weightOptions = withCurrent(
    [
      same,
      { value: '400', label: t('weightNames.regular') },
      { value: '500', label: t('weightNames.medium') },
      { value: '600', label: t('weightNames.semibold') },
      { value: '700', label: t('weightNames.bold') },
    ],
    values.fontWeight
  );
  const caseOptions: SegmentOption[] = [
    same,
    { value: 'uppercase', label: t('caseNames.upper') },
    { value: 'lowercase', label: t('caseNames.lower') },
    { value: 'capitalize', label: t('caseNames.capitalize') },
    { value: 'none', label: t('caseNames.none') },
  ];
  const decoOptions: SegmentOption[] = [
    same,
    { value: 'none', label: t('decoNames.none') },
    { value: 'underline', label: t('decoNames.underline') },
    { value: 'overline', label: t('decoNames.overline') },
    { value: 'line-through', label: t('decoNames.strikethrough') },
  ];
  const alignOptions: SegmentOption[] = (['', 'start', 'center', 'end'] as const).map(v => {
    const key = v === '' ? 'auto' : v;
    return { value: v, label: t(`alignNames.${key}`), icon: <AlignIcon kind={key} /> };
  });

  // Live specimen: the zone as it will read (font, size, weight, case, decoration, a hex colour).
  const specimenStyle: CSSProperties = {
    fontFamily: values.fontFamily
      ? `"${values.fontFamily.replace(/^["']|["']$/g, '')}", system-ui`
      : undefined,
    fontSize: values.fontSize || undefined,
    fontWeight: values.fontWeight || undefined,
    textTransform: values.textTransform,
    textDecoration: values.textDecoration,
    letterSpacing: values.letterSpacing || undefined,
    lineHeight: values.lineHeight || undefined,
    color: values.color?.startsWith('#') ? values.color : undefined,
  };

  // Standalone zone card; the parent may pass className="" when it already provides a border.
  const containerClass =
    className !== undefined ? className : 'rounded-lg border border-border bg-card p-4';
  const resetButton =
    hasValues && onReset ? (
      <Button variant="link" size="sm" type="button" onClick={onReset} className="shrink-0">
        {t('resetToDefault')}
      </Button>
    ) : null;

  return (
    // data-zone-key is used by e2e tests and browser devtools to identify which zone this editor controls.
    <div className={containerClass} data-zone-key={zoneKey}>
      {!hideLabel ? (
        <div className="flex items-center justify-between gap-2">
          <h4 className="min-w-0 text-sm font-semibold text-foreground">{zoneLabel}</h4>
          {resetButton}
        </div>
      ) : (
        resetButton && <div className="flex justify-end">{resetButton}</div>
      )}

      <div className={`${hideLabel ? '' : 'mt-3'} flex flex-col gap-4`}>
        <p
          className="min-h-12 break-words rounded-md bg-muted px-3 py-2 text-foreground"
          style={specimenStyle}
          aria-hidden="true"
          data-testid="zone-specimen"
        >
          {t('specimen')}
        </p>

        <Field label={t('fontFamilyLabel')}>
          {fontFamilyOptions ? (
            <select
              aria-label={t('fontFamilyLabel')}
              value={values.fontFamily ?? ''}
              onChange={e => onChange({ fontFamily: e.target.value })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:h-10 sm:text-sm"
            >
              {fontFamilyOptions.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : fonts ? (
            <FontPicker
              label={t('fontFamilyLabel')}
              value={values.fontFamily ?? ''}
              fonts={fonts}
              onChange={family => onChange({ fontFamily: family })}
            />
          ) : (
            <TextInput
              type="text"
              aria-label={t('fontFamilyLabel')}
              value={values.fontFamily ?? ''}
              onChange={e => onChange({ fontFamily: e.target.value })}
              placeholder={placeholder?.fontFamily || t('same')}
            />
          )}
        </Field>

        <Field label={t('fontSizeLabel')}>
          <Segmented
            label={t('fontSizeLabel')}
            value={values.fontSize ?? ''}
            options={sizeOptions}
            onChange={v => onChange({ fontSize: v })}
          />
        </Field>

        <Field label={t('fontWeightLabel')}>
          <Segmented
            label={t('fontWeightLabel')}
            value={values.fontWeight ?? ''}
            options={weightOptions}
            onChange={v => onChange({ fontWeight: v })}
          />
        </Field>

        <Field label={t('textAlignmentLabel')}>
          <Segmented
            iconOnly
            label={t('textAlignmentLabel')}
            value={values.textAlign ?? ''}
            options={alignOptions}
            onChange={v =>
              onChange({ textAlign: v === '' ? undefined : (v as ZoneOverride['textAlign']) })
            }
          />
        </Field>

        {renderColorField ? (
          renderColorField()
        ) : (
          <ColorField
            label={t('textColorLabel')}
            value={values.color}
            onChange={v => onChange({ color: v })}
            hint={
              placeholder?.color
                ? t('colorInheriting', { value: placeholder.color })
                : t('colorHint')
            }
            theme={theme}
            inheritFromToken={inheritFromToken}
          />
        )}

        <Disclosure title={t('moreOptions')} testId={`zone-more-${zoneKey}`}>
          <div className="flex flex-col gap-4">
            <Field label={t('textTransformLabel')}>
              <Segmented
                label={t('textTransformLabel')}
                value={values.textTransform ?? ''}
                options={caseOptions}
                onChange={v =>
                  onChange({
                    textTransform: v === '' ? undefined : (v as ZoneOverride['textTransform']),
                  })
                }
              />
            </Field>
            <Field label={t('textDecorationLabel')}>
              <Segmented
                label={t('textDecorationLabel')}
                value={values.textDecoration ?? ''}
                options={decoOptions}
                onChange={v =>
                  onChange({
                    textDecoration: v === '' ? undefined : (v as ZoneOverride['textDecoration']),
                  })
                }
              />
            </Field>
            <Field
              label={t('exactSizeLabel')}
              hint={t('exactSizeHint')}
              error={sizeRejected ? t('arbitrarySizeNotAllowed') : undefined}
            >
              <TextInput
                type="text"
                aria-label={t('exactSizeLabel')}
                value={values.fontSize ?? ''}
                onChange={e => handleSize('fontSize', e.target.value)}
                onBlur={e => {
                  // PC-4: reject Tailwind arbitrary bracket syntax (text-[20px] etc.): it bypasses the scale and
                  // wins specificity over the per-store CSS emitter, silently no-oping merchant overrides.
                  const v = normaliseSizeValue(e.target.value);
                  if (v && /text-\[/.test(v)) {
                    onChange({ fontSize: '' });
                    setSizeRejected(true);
                  }
                }}
                placeholder={placeholder?.fontSize || t('fontSizeExample')}
              />
            </Field>
            <Field label={t('letterSpacingLabel')}>
              <TextInput
                type="text"
                aria-label={t('letterSpacingLabel')}
                value={values.letterSpacing ?? ''}
                onChange={e => handleSize('letterSpacing', e.target.value)}
                placeholder={placeholder?.letterSpacing || t('letterSpacingExample')}
              />
            </Field>
            <Field label={t('lineHeightLabel')}>
              <TextInput
                type="text"
                aria-label={t('lineHeightLabel')}
                value={values.lineHeight ?? ''}
                onChange={e => handleSize('lineHeight', e.target.value)}
                placeholder={placeholder?.lineHeight || t('lineHeightExample')}
              />
            </Field>
          </div>
        </Disclosure>
      </div>
    </div>
  );
}

/** Logical alignment glyphs: start/end lines are drawn from the reading edge, so they mirror in Arabic. */
function AlignIcon({ kind }: { kind: 'auto' | 'start' | 'center' | 'end' }) {
  const lines =
    kind === 'center'
      ? [
          [3, 13],
          [5, 11],
          [3, 13],
        ]
      : kind === 'end'
        ? [
            [3, 13],
            [7, 13],
            [3, 13],
          ]
        : [
            [3, 13],
            [3, 9],
            [3, 13],
          ];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={kind === 'auto' ? 'opacity-60' : 'rtl:-scale-x-100'}
    >
      {lines.map(([a, b], i) => (
        <path key={i} d={`M${a} ${4 + i * 4}H${b}`} />
      ))}
    </svg>
  );
}
