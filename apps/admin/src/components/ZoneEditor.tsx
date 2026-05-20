'use client';

import type { ReactNode } from 'react';
import type { ZoneOverride, StoreTheme, ColorToken } from '@force/shared';
import { ColorField } from './ColorField';

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
 *   1. Per-section typography overrides inside the page-builder SectionCard blocks.
 *   2. The "Default typography" SectionCard at the bottom of the page-builder that
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
  const hasValues = hasAnyValue(values);

  // Build placeholder text for each field from the inherited zone values.
  const ph = (field: keyof ZoneOverride): string => {
    const v = placeholder?.[field];
    return typeof v === 'string' && v ? `inherit (${v})` : 'inherit';
  };

  const handleSize = (field: 'fontSize' | 'letterSpacing' | 'lineHeight', raw: string) => {
    onChange({ [field]: normaliseSizeValue(raw) });
  };

  // Default styling: standalone zone card with border and padding.
  // When embedded inside an existing bordered block, the parent can pass
  // className="" to suppress the outer border (avoids nested double-borders).
  const containerClass =
    className !== undefined ? className : 'rounded-xl border border-border/60 bg-background p-4';

  return (
    // data-zone-key is used by e2e tests and browser devtools to identify
    // which zone this editor controls.
    <div className={containerClass} data-zone-key={zoneKey}>
      {!hideLabel && (
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground capitalize">{zoneLabel}</h4>
          {hasValues && onReset && (
            <button
              type="button"
              onClick={onReset}
              className="text-[11px] text-destructive hover:underline shrink-0"
            >
              Reset to default
            </button>
          )}
        </div>
      )}
      {/* When label is hidden but reset is available, show reset link inline */}
      {hideLabel && hasValues && onReset && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] text-destructive hover:underline shrink-0"
          >
            Reset to default
          </button>
        </div>
      )}

      <div className={`${hideLabel ? '' : 'mt-3'} grid gap-3 sm:grid-cols-2 lg:grid-cols-3`}>
        {/* Font family — select when fontFamilyOptions are provided (typography page
            has a curated font library); free-form text input otherwise (page-builder
            context where no font library is loaded). */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Font family</span>
          {fontFamilyOptions ? (
            <select
              value={values.fontFamily ?? ''}
              onChange={e => onChange({ fontFamily: e.target.value })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
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
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
            />
          )}
        </label>

        {/* Font size */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Font size</span>
          <input
            type="text"
            value={values.fontSize ?? ''}
            onChange={e => handleSize('fontSize', e.target.value)}
            placeholder={ph('fontSize') === 'inherit' ? 'e.g. 16px or 1rem' : ph('fontSize')}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
          />
          <span className="text-[11px] text-muted-foreground/80">
            Bare number auto-converts to px (16 → 16px).
          </span>
        </label>

        {/* Font weight */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Font weight</span>
          <input
            type="text"
            value={values.fontWeight ?? ''}
            onChange={e => onChange({ fontWeight: e.target.value })}
            placeholder={ph('fontWeight') === 'inherit' ? 'e.g. 400, 600, 700' : ph('fontWeight')}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
          />
          <span className="text-[11px] text-muted-foreground/80">
            400 regular · 600 semibold · 700 bold
          </span>
        </label>

        {/* Letter spacing */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Letter spacing</span>
          <input
            type="text"
            value={values.letterSpacing ?? ''}
            onChange={e => handleSize('letterSpacing', e.target.value)}
            placeholder={
              ph('letterSpacing') === 'inherit' ? 'e.g. 0.05em or 1px' : ph('letterSpacing')
            }
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
          />
        </label>

        {/* Line height */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Line height</span>
          <input
            type="text"
            value={values.lineHeight ?? ''}
            onChange={e => handleSize('lineHeight', e.target.value)}
            placeholder={ph('lineHeight') === 'inherit' ? 'e.g. 1.6 or 24px' : ph('lineHeight')}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
          />
        </label>

        {/* Text transform */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Text transform</span>
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
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Inherit (none)</option>
            <option value="uppercase">Uppercase</option>
            <option value="lowercase">Lowercase</option>
            <option value="capitalize">Capitalize</option>
            <option value="none">None (explicit)</option>
          </select>
        </label>

        {/* Text decoration (underline / strikethrough / overline) — 2026-05-20.
            Sits beside text-transform; applies via inline style.textDecoration
            on the zone's text element. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Text decoration</span>
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
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Inherit (none)</option>
            <option value="underline">Underline</option>
            <option value="overline">Overline</option>
            <option value="line-through">Strikethrough</option>
            <option value="none">None (explicit)</option>
          </select>
        </label>
      </div>

      {/* Text alignment — pulled OUT of the grid above and rendered full-width
          for breathing room (same reasoning as Color below). When nested in
          the 3-col grid the 4 buttons + labels were getting clipped by
          overflow-hidden, especially inside Smart Palette modal where the
          editor column is ~150px wide.

          Logical values (start/center/end) so RTL Arabic flips correctly.
          4-button segmented control with rounded outer corners + dividers
          between options. Each label has an aria-label spelling out the
          LTR/RTL effect for screen readers. */}
      <div className="mt-3 flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Text alignment</span>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-border">
          {(
            [
              { value: '', label: 'Auto', title: 'Inherit (use consumer default)' },
              { value: 'start', label: 'Start', title: 'Left in LTR, right in RTL' },
              { value: 'center', label: 'Center', title: 'Always centered' },
              { value: 'end', label: 'End', title: 'Right in LTR, left in RTL' },
            ] as const
          ).map((opt, i) => {
            const active = (values.textAlign ?? '') === opt.value;
            return (
              <button
                key={opt.value || 'auto'}
                type="button"
                title={opt.title}
                aria-label={`${opt.label} — ${opt.title}`}
                onClick={() =>
                  onChange({
                    textAlign:
                      opt.value === '' ? undefined : (opt.value as ZoneOverride['textAlign']),
                  })
                }
                className={`px-3 py-2 text-sm font-medium transition-colors ${
                  i > 0 ? 'border-s border-border' : ''
                } ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {opt.label}
              </button>
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
            label="Text color"
            value={values.color}
            onChange={v => onChange({ color: v })}
            hint={
              placeholder?.color
                ? `Inheriting: ${placeholder.color}`
                : 'Leave empty to inherit from active theme.'
            }
            theme={theme}
            inheritFromToken={inheritFromToken}
          />
        )}
      </div>
    </div>
  );
}
