'use client';

import { Button } from '@/components/ui/Button';
import { useState, type ReactNode } from 'react';
import type { ZoneOverride, StoreTheme, ColorToken } from '@ebda/shared';
import { ColorField } from './ColorField';
import { useT } from '@/i18n/useT';
import { FIELD_CLASSES } from '@/components/ui/tokens';

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
}: ZoneEditorProps) {
  const t = useT('zoneEditor');
  const hasValues = hasAnyValue(values);
  // UX:C-3 - inline feedback instead of a native alert().
  const [sizeRejected, setSizeRejected] = useState(false);

  // Build placeholder text for each field from the inherited zone values.
  const ph = (field: keyof ZoneOverride): string => {
    const v = placeholder?.[field];
    return typeof v === 'string' && v ? t('inheritWithValue', { value: v }) : t('inherit');
  };

  const handleSize = (field: 'fontSize' | 'letterSpacing' | 'lineHeight', raw: string) => {
    if (field === 'fontSize') setSizeRejected(false);
    onChange({ [field]: normaliseSizeValue(raw) });
  };

  // Default styling: standalone zone card with border and padding.
  // When embedded inside an existing bordered block, the parent can pass
  // className="" to suppress the outer border (avoids nested double-borders).
  const containerClass =
    className !== undefined ? className : 'rounded-md border border-border/60 bg-background p-4';

  return (
    // data-zone-key is used by e2e tests and browser devtools to identify
    // which zone this editor controls.
    <div className={containerClass} data-zone-key={zoneKey}>
      {!hideLabel && (
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground capitalize">{zoneLabel}</h4>
          {hasValues && onReset && (
            <Button
              variant="link"
              size="sm"
              type="button"
              onClick={onReset}
              className="text-destructive-ink shrink-0"
            >
              {t('resetToDefault')}
            </Button>
          )}
        </div>
      )}
      {/* When label is hidden but reset is available, show reset link inline */}
      {hideLabel && hasValues && onReset && (
        <div className="flex justify-end">
          <Button
            variant="link"
            size="sm"
            type="button"
            onClick={onReset}
            className="text-destructive-ink shrink-0"
          >
            {t('resetToDefault')}
          </Button>
        </div>
      )}

      <div className={`${hideLabel ? '' : 'mt-3'} grid gap-3 sm:grid-cols-2 lg:grid-cols-3`}>
        {/* Font family — select when fontFamilyOptions are provided (typography page
            has a curated font library); free-form text input otherwise (the editor
            context where no font library is loaded). */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('fontFamilyLabel')}</span>
          {fontFamilyOptions ? (
            <select
              value={values.fontFamily ?? ''}
              onChange={e => onChange({ fontFamily: e.target.value })}
              className={FIELD_CLASSES}
            >
              {fontFamilyOptions.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values.fontFamily ?? ''}
              onChange={e => onChange({ fontFamily: e.target.value })}
              placeholder={ph('fontFamily')}
              className={FIELD_CLASSES}
            />
          )}
        </label>

        {/* Font size */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('fontSizeLabel')}</span>
          <input
            type="text"
            value={values.fontSize ?? ''}
            onChange={e => handleSize('fontSize', e.target.value)}
            onBlur={e => {
              // PC-4: reject Tailwind arbitrary bracket syntax (text-[20px] etc.)
              // on blur so the merchant sees inline feedback immediately.
              // Allowed: px / rem / em / % values, or Tailwind named tokens
              // (text-xs / text-sm / text-base / text-lg / text-xl / text-2xl).
              // The canonical 4-step scale is: 12px / 14px / 16px / 18px / 22px.
              // Bracket syntax bypasses the scale + wins specificity over the
              // per-store CSS emitter, silently no-oping merchant overrides.
              const v = normaliseSizeValue(e.target.value);
              if (v && /text-\[/.test(v)) {
                onChange({ fontSize: '' });
                setSizeRejected(true);
              }
            }}
            placeholder={ph('fontSize') === t('inherit') ? t('fontSizeExample') : ph('fontSize')}
            className={FIELD_CLASSES}
          />
          {sizeRejected ? (
            <span role="alert" className="whitespace-pre-line text-xs text-destructive-ink">
              {t('arbitrarySizeNotAllowed')}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground/80">{t('fontSizeHint')}</span>
        </label>

        {/* Font weight */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('fontWeightLabel')}</span>
          <input
            type="text"
            value={values.fontWeight ?? ''}
            onChange={e => onChange({ fontWeight: e.target.value })}
            placeholder={
              ph('fontWeight') === t('inherit') ? t('fontWeightExample') : ph('fontWeight')
            }
            className={FIELD_CLASSES}
          />
          <span className="text-xs text-muted-foreground/80">{t('fontWeightHint')}</span>
        </label>

        {/* Letter spacing */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t('letterSpacingLabel')}
          </span>
          <input
            type="text"
            value={values.letterSpacing ?? ''}
            onChange={e => handleSize('letterSpacing', e.target.value)}
            placeholder={
              ph('letterSpacing') === t('inherit') ? t('letterSpacingExample') : ph('letterSpacing')
            }
            className={FIELD_CLASSES}
          />
        </label>

        {/* Line height */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('lineHeightLabel')}</span>
          <input
            type="text"
            value={values.lineHeight ?? ''}
            onChange={e => handleSize('lineHeight', e.target.value)}
            placeholder={
              ph('lineHeight') === t('inherit') ? t('lineHeightExample') : ph('lineHeight')
            }
            className={FIELD_CLASSES}
          />
        </label>

        {/* Text transform */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t('textTransformLabel')}
          </span>
          <select
            value={values.textTransform ?? ''}
            onChange={e =>
              onChange({
                textTransform:
                  e.target.value === ''
                    ? undefined
                    : (e.target.value as ZoneOverride['textTransform']),
              })
            }
            className={FIELD_CLASSES}
          >
            <option value="">{t('textTransformOptions.inherit')}</option>
            <option value="uppercase">{t('textTransformOptions.uppercase')}</option>
            <option value="lowercase">{t('textTransformOptions.lowercase')}</option>
            <option value="capitalize">{t('textTransformOptions.capitalize')}</option>
            <option value="none">{t('textTransformOptions.explicitNone')}</option>
          </select>
        </label>

        {/* Text decoration (underline / strikethrough / overline) — 2026-05-20.
            Sits beside text-transform; applies via inline style.textDecoration
            on the zone's text element. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t('textDecorationLabel')}
          </span>
          <select
            value={values.textDecoration ?? ''}
            onChange={e =>
              onChange({
                textDecoration:
                  e.target.value === ''
                    ? undefined
                    : (e.target.value as ZoneOverride['textDecoration']),
              })
            }
            className={FIELD_CLASSES}
          >
            <option value="">{t('textDecorationOptions.inherit')}</option>
            <option value="none">{t('textDecorationOptions.none')}</option>
            <option value="underline">{t('textDecorationOptions.underline')}</option>
            <option value="overline">{t('textDecorationOptions.overline')}</option>
            <option value="line-through">{t('textDecorationOptions.strikethrough')}</option>
          </select>
        </label>
      </div>

      {/* Text alignment — pulled OUT of the grid above and rendered full-width
          for breathing room (same reasoning as Color below). When nested in
          the 3-col grid the 4 buttons + labels were getting clipped by
          overflow-hidden, especially inside Smart Palette modal where the
          editor column is ~150px wide.

          Logical values (start/center/end) so RTL Arabic flips correctly.
          4-button segmented control with rounded-md outer corners + dividers
          between options. Each label has an aria-label spelling out the
          LTR/RTL effect for screen readers. */}
      <div className="mt-3 flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t('textAlignmentLabel')}</span>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-border">
          {(
            [
              { value: '', key: 'auto' },
              { value: 'start', key: 'start' },
              { value: 'center', key: 'center' },
              { value: 'end', key: 'end' },
            ] as const
          ).map(opt => {
            const active = (values.textAlign ?? '') === opt.value;
            const label = t(`textAlign.${opt.key}.label`);
            const title = t(`textAlign.${opt.key}.title`);
            return (
              <Button
                variant={active ? 'soft' : 'ghost'}
                size="sm"
                key={opt.value || 'auto'}
                type="button"
                title={title}
                aria-label={t('textAlignAriaLabel', { label, title })}
                onClick={() =>
                  onChange({
                    textAlign:
                      opt.value === '' ? undefined : (opt.value as ZoneOverride['textAlign']),
                  })
                }
              >
                {label}
              </Button>
            );
          })}
        </div>
      </div>

      {/* Color — full-width below the grid for breathing room.
          When renderColorField is provided by the parent (e.g. the legacy
          typography page uses a different brand-preset format), the default
          ColorField is skipped entirely and the parent's UI is rendered. */}
      <div className="mt-3">
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
      </div>
    </div>
  );
}
