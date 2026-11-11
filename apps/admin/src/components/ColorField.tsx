'use client';

import { Button } from '@/components/ui/Button';
import { useState, useCallback, useRef } from 'react';
import { ColorContrastPreview } from './ColorContrastPreview';
import { COLOR_TOKENS, resolveColor } from '@ebda/shared';
import type { StoreTheme, ColorToken } from '@ebda/shared';
import { useT } from '@/i18n/useT';

interface ColorFieldProps {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  hint?: string;
  /** Store theme — required so the brand-token dropdown can resolve tokens for the preview. */
  theme: StoreTheme | undefined;
  /** Optional merchant-picked foreground color (from a typography zone) for the preview warning. */
  previewFg?: string;
  /**
   * When the merchant has not picked a value yet, show the inherited brand color
   * as the empty-state label instead of the generic "— Theme default —" text.
   *
   * E.g. `inheritFromToken="card"` on a bgColor field will show
   * "Brand: Surface: Card (#f5f0eb)" when the merchant's theme has `cardColor` set.
   *
   * The stored value stays empty — this is only a visual hint. Setting a value
   * or clicking "Clear" behaves normally.
   */
  inheritFromToken?: ColorToken;
  /**
   * When false, suppress the inline ColorContrastPreview band. Useful when the
   * caller renders its own contrast preview elsewhere (e.g. SmartPaletteModal's
   * tile shows the full-section preview; the per-field band is redundant).
   * Default true (existing behavior).
   */
  showContrastPreview?: boolean;
}

const CUSTOM = '__custom__';

/**
 * Normalize a raw hex string to a canonical '#RRGGBB' form.
 * Accepts with/without leading '#', 3- or 6-digit hex.
 * Returns the normalized string on success, or null when the input is not a
 * valid 3- or 6-digit hex value.
 */
function normalizeHex(raw: string): string | null {
  const stripped = raw.replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(stripped)) {
    // Expand 3-digit shorthand: e.g. 'f0a' → 'ff00aa'
    const expanded = stripped
      .split('')
      .map(c => c + c)
      .join('');
    return `#${expanded}`;
  }
  if (/^[0-9a-f]{6}$/.test(stripped)) {
    return `#${stripped}`;
  }
  return null;
}

export function ColorField({
  label,
  value,
  onChange,
  hint,
  theme,
  previewFg,
  inheritFromToken,
  showContrastPreview = true,
}: ColorFieldProps) {
  const t = useT('components.colorField');
  const tokenLabel = useCallback(
    (token: (typeof COLOR_TOKENS)[number]) => t(`tokens.${token}` as Parameters<typeof t>[0]),
    [t]
  );
  const isToken = value?.startsWith('token:') ?? false;
  const tokenName = isToken ? (value as string).slice(6) : '';
  const hexValue = !isToken ? value || '' : '';

  const selectValue = isToken ? tokenName : value ? CUSTOM : '';

  // Local state for the hex text input — lets the user type freely without
  // the field resetting mid-input. Synced to hexValue whenever it changes
  // externally (e.g. the native color picker or a token selection).
  const [rawHex, setRawHex] = useState<string>(hexValue);

  // Remember the last custom hex the merchant entered so switching Custom →
  // brand token → Custom restores it instead of resetting to #ffffff (Ahmad
  // 2026-06-20). Updated at render whenever a custom hex is active; survives a
  // token selection because the ref persists while `hexValue` goes empty.
  const lastCustomHexRef = useRef<string>(hexValue || '');
  if (!isToken && hexValue) lastCustomHexRef.current = hexValue;

  // Keep rawHex in sync when the committed value changes externally (native
  // picker, token switch, clear, or parent-set value).
  // We intentionally don't use useEffect here to avoid stale-closure issues;
  // instead we sync inline when selectValue or hexValue changes.
  const syncedHex = !isToken ? hexValue : '';
  // Use a ref-style pattern: if committed hex differs from what we have in
  // raw state and the user isn't mid-type (i.e. raw already normalizes to
  // the same value), update raw. But to keep it simple and avoid infinite
  // loops, we only force-sync when the source is external (isToken changed
  // or hexValue was reset to empty).
  const handleExternalSync = useCallback(() => {
    setRawHex(syncedHex);
  }, [syncedHex]);

  // Compute the inherited brand-color label for the empty-state option.
  // Only shown when no value is set and inheritFromToken is provided AND the
  // theme actually has the token set (non-empty resolution).
  const inheritedResolvedHex =
    !value && inheritFromToken && theme
      ? resolveColor(`token:${inheritFromToken}`, theme)
      : undefined;
  const inheritedLabel =
    inheritedResolvedHex && inheritFromToken
      ? t('inheritedLabel', { token: tokenLabel(inheritFromToken), hex: inheritedResolvedHex })
      : t('themeDefault');

  const handleSelectChange = (next: string) => {
    if (next === '') {
      onChange('');
      setRawHex('');
    } else if (next === CUSTOM) {
      // Restore the merchant's last custom hex (preserved across a token
      // selection) rather than resetting to white.
      const currentHex = hexValue || lastCustomHexRef.current || '#ffffff';
      onChange(currentHex);
      setRawHex(currentHex);
    } else {
      onChange(`token:${next}`);
      setRawHex('');
    }
  };

  /** Commit rawHex to parent if it resolves to a valid 6-digit hex. */
  const commitHex = useCallback(
    (raw: string) => {
      const normalized = normalizeHex(raw);
      if (normalized) {
        onChange(normalized);
      }
    },
    [onChange]
  );

  const handleHexTextChange = (raw: string) => {
    setRawHex(raw);
    // Fire onChange immediately when the typed text is already valid.
    const normalized = normalizeHex(raw);
    if (normalized) {
      onChange(normalized);
    }
  };

  const handleHexTextBlur = () => {
    commitHex(rawHex);
    // If invalid on blur, revert raw to the last committed hex so the field
    // doesn't stay in a broken state.
    if (!normalizeHex(rawHex)) {
      setRawHex(hexValue || '');
    }
  };

  // When isToken switches off (e.g. user picked "Custom hex…"), reset raw.
  // We track this via the select's side-effect in handleSelectChange above.

  void handleExternalSync; // used implicitly via handleSelectChange

  return (
    <div className="flex flex-col gap-2 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <select
          // the visible label is a sibling span, not a <label>: name the control for AT
          aria-label={label}
          value={selectValue}
          onChange={e => handleSelectChange(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="">{inheritedLabel}</option>
          {COLOR_TOKENS.map(token => (
            <option key={token} value={token}>
              {tokenLabel(token)}
            </option>
          ))}
          <option value={CUSTOM}>{t('customHex')}</option>
        </select>
        {!isToken && value ? (
          <>
            {/* Native color picker — acts as a visual swatch + system color wheel. */}
            <input
              type="color"
              value={(normalizeHex(hexValue) ?? hexValue) || '#ffffff'}
              onChange={e => {
                const next = e.target.value;
                onChange(next);
                setRawHex(next);
              }}
              className="h-11 w-11 cursor-pointer rounded border border-border bg-background p-0.5"
              aria-label={t('colorPickerAriaLabel')}
            />
            {/* Hex text field — primary input path; ≥44px touch target. */}
            <input
              type="text"
              inputMode="text"
              value={rawHex}
              onChange={e => handleHexTextChange(e.target.value)}
              onBlur={handleHexTextBlur}
              placeholder="#RRGGBB"
              maxLength={7}
              className="h-11 w-28 rounded border border-border bg-background px-2 py-1 font-mono text-sm uppercase text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              aria-label={t('hexValueAriaLabel')}
            />
          </>
        ) : null}
        {value ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => {
              onChange('');
              setRawHex('');
            }}
            className="text-muted-foreground"
          >
            {t('clear')}
          </Button>
        ) : null}
      </div>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {showContrastPreview && value && theme ? (
        <ColorContrastPreview bg={value} theme={theme} pickedFg={previewFg} />
      ) : null}
    </div>
  );
}
