'use client';

import { ColorContrastPreview } from './ColorContrastPreview';
import { COLOR_TOKENS, resolveColor } from '@force/shared';
import type { StoreTheme, ColorToken } from '@force/shared';

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
}

const TOKEN_LABELS: Record<(typeof COLOR_TOKENS)[number], string> = {
  primary: 'Brand: Primary',
  secondary: 'Brand: Secondary',
  accent: 'Brand: Accent',
  card: 'Surface: Card',
  muted: 'Surface: Muted',
  foreground: 'Text: Foreground',
  border: 'Border',
};

const CUSTOM = '__custom__';

export function ColorField({
  label,
  value,
  onChange,
  hint,
  theme,
  previewFg,
  inheritFromToken,
}: ColorFieldProps) {
  const isToken = value?.startsWith('token:') ?? false;
  const tokenName = isToken ? (value as string).slice(6) : '';
  const hexValue = !isToken ? value || '' : '';

  const selectValue = isToken ? tokenName : value ? CUSTOM : '';

  // Compute the inherited brand-color label for the empty-state option.
  // Only shown when no value is set and inheritFromToken is provided AND the
  // theme actually has the token set (non-empty resolution).
  const inheritedResolvedHex =
    !value && inheritFromToken && theme
      ? resolveColor(`token:${inheritFromToken}`, theme)
      : undefined;
  const inheritedLabel =
    inheritedResolvedHex && inheritFromToken
      ? `Brand: ${TOKEN_LABELS[inheritFromToken]} (${inheritedResolvedHex})`
      : '— Theme default —';

  const handleSelectChange = (next: string) => {
    if (next === '') {
      onChange('');
    } else if (next === CUSTOM) {
      onChange(hexValue || '#ffffff');
    } else {
      onChange(`token:${next}`);
    }
  };

  return (
    <div className="flex flex-col gap-2 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <select
          value={selectValue}
          onChange={e => handleSelectChange(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="">{inheritedLabel}</option>
          {COLOR_TOKENS.map(t => (
            <option key={t} value={t}>
              {TOKEN_LABELS[t]}
            </option>
          ))}
          <option value={CUSTOM}>Custom hex…</option>
        </select>
        {!isToken && value ? (
          <input
            type="color"
            value={hexValue || '#ffffff'}
            onChange={e => onChange(e.target.value)}
            className="h-8 w-12 cursor-pointer rounded border border-border bg-background"
          />
        ) : null}
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-xs text-muted-foreground underline"
          >
            Clear
          </button>
        ) : null}
      </div>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {value && theme ? (
        <ColorContrastPreview bg={value} theme={theme} pickedFg={previewFg} />
      ) : null}
    </div>
  );
}
