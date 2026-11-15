'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useId, useState } from 'react';
import { ColorContrastPreview } from './ColorContrastPreview';
import { COLOR_TOKENS, resolveColorForMeasure } from '@ebda/shared';
import type { StoreTheme, ColorToken } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Chevron, Field, TextInput } from './ui/Field';
import { cn } from '@ebda/ui/cn';

interface ColorFieldProps {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  hint?: string;
  /** Store theme: resolves the brand colours for the swatches and the preview. */
  theme: StoreTheme | undefined;
  /** Optional merchant-picked foreground colour (from a typography zone) for the preview warning. */
  previewFg?: string;
  /**
   * When the merchant has not picked a value yet, show the inherited brand colour as the empty-state label.
   * The stored value stays empty: this is only a visual hint.
   */
  inheritFromToken?: ColorToken;
  /** When false, suppress the inline preview (the caller draws its own, e.g. the Smart Palette tile). */
  showContrastPreview?: boolean;
}

const RECENT_KEY = 'ebda.colors.recent';
const RECENT_MAX = 6;

/**
 * Normalize a typed or pasted colour to '#RRGGBB'. Trims spaces, accepts with/without '#', 3, 6 or 8 digits (an
 * alpha pair is dropped: stored colours are opaque). Null when it is not a colour.
 */
function normalizeHex(raw: string): { hex: string; alphaDropped: boolean } | null {
  const s = raw.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s))
    return {
      hex: `#${s
        .split('')
        .map(c => c + c)
        .join('')}`,
      alphaDropped: false,
    };
  if (/^[0-9a-f]{6}$/.test(s)) return { hex: `#${s}`, alphaDropped: false };
  if (/^[0-9a-f]{8}$/.test(s)) return { hex: `#${s.slice(0, 6)}`, alphaDropped: true };
  return null;
}

function readRecent(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}
function rememberRecent(hex: string): string[] {
  const next = [hex, ...readRecent().filter(h => h !== hex)].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: recents just do not persist */
  }
  return next;
}

/** A colour square; a colour that cannot be resolved shows as an empty dashed square, never as black. */
function Swatch({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-6 w-6 shrink-0 rounded-md border border-border',
        color ? '' : 'border-dashed bg-muted',
        className
      )}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
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
  const id = useId();
  const [open, setOpen] = useState(false);
  const isToken = value?.startsWith('token:') ?? false;
  const tokenName = isToken ? (value as string).slice(6) : '';
  const hexValue = !isToken ? (value ?? '') : '';
  const [raw, setRaw] = useState(hexValue);
  const [error, setError] = useState(false);
  const [alphaDropped, setAlphaDropped] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => setRaw(hexValue), [hexValue]);
  useEffect(() => {
    if (open) setRecent(readRecent());
  }, [open]);

  const plain = (token: string) => t(`tokens.${token}` as Parameters<typeof t>[0]);
  const swatchOf = (v: string | undefined) => resolveColorForMeasure(v, theme);

  const inherited = inheritFromToken ? `token:${inheritFromToken}` : undefined;
  const shownName = isToken
    ? plain(tokenName)
    : value
      ? value.toUpperCase()
      : inheritFromToken
        ? t('inheritedLabel', { token: plain(inheritFromToken) })
        : t('themeDefault');
  const shownSwatch = swatchOf(value || inherited);

  const commit = (hex: string) => {
    onChange(hex);
    setRecent(rememberRecent(hex));
  };
  const tryCommit = (text: string, onBlur: boolean) => {
    const n = normalizeHex(text);
    if (n) {
      setError(false);
      setAlphaDropped(n.alphaDropped);
      setRaw(n.hex);
      commit(n.hex);
    } else if (onBlur && text.trim() !== '') {
      setError(true);
    }
  };

  const chips: Array<{ id: string; value: string; name: string }> = [
    { id: 'default', value: '', name: t('themeDefaultShort') },
    ...COLOR_TOKENS.map(tok => ({ id: tok, value: `token:${tok}`, name: plain(tok) })),
  ];
  const selectedChip = isToken ? value : value ? '__custom__' : '';

  return (
    <div className="flex flex-col gap-2 py-2">
      <span id={`${id}-label`} className="text-sm font-medium text-foreground">
        {label}
      </span>
      <button
        data-ui="row"
        type="button"
        aria-labelledby={`${id}-label ${id}-trigger`}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen(o => !o)}
        className="flex h-11 w-full min-w-0 items-center gap-3 rounded-md border border-input bg-background px-3 text-start text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10"
      >
        <Swatch color={shownSwatch} />
        <span id={`${id}-trigger`} className="min-w-0 flex-1 truncate">
          {shownName}
        </span>
        {value && !isToken && shownSwatch && (
          <span dir="ltr" className="text-xs text-muted-ink">
            {shownSwatch}
          </span>
        )}
        <Chevron
          className={cn(
            'h-4 w-4 shrink-0 text-muted-ink transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div
          id={`${id}-panel`}
          role="group"
          aria-label={label}
          className="space-y-3 rounded-md border border-border bg-card p-3 shadow-md"
          data-testid="color-panel"
        >
          <div role="radiogroup" aria-label={t('brandColours')} className="grid grid-cols-2 gap-1">
            {chips.map(c => {
              const on = selectedChip === c.value;
              return (
                <button
                  key={c.id}
                  data-ui="swatch"
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    onChange(c.value);
                    setRaw('');
                    setError(false);
                  }}
                  className={cn(
                    'flex min-h-10 min-w-0 items-center gap-2 rounded-md border px-2 text-start text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on
                      ? 'border-primary bg-primary/15 text-primary-ink'
                      : 'border-border hover:bg-accent'
                  )}
                >
                  <Swatch color={swatchOf(c.value || inherited)} className="h-5 w-5" />
                  <span className="min-w-0 flex-1 break-words">{c.name}</span>
                  {on && <span aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>

          <div className="flex items-end gap-2">
            <Field
              className="flex-1"
              label={t('anyColour')}
              htmlFor={`${id}-hex`}
              error={error ? t('notAColour') : undefined}
              hint={alphaDropped ? t('alphaIgnored') : undefined}
            >
              <TextInput
                id={`${id}-hex`}
                dir="ltr"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                value={raw}
                placeholder={t('hexExample')}
                aria-label={t('hexValueAriaLabel')}
                aria-invalid={error || undefined}
                className="font-mono uppercase"
                onChange={e => {
                  setRaw(e.target.value);
                  setError(false);
                  tryCommit(e.target.value, false);
                }}
                onBlur={() => tryCommit(raw, true)}
              />
            </Field>
            <input
              type="color"
              value={normalizeHex(hexValue)?.hex ?? '#ffffff'}
              onChange={e => {
                setRaw(e.target.value);
                setError(false);
                commit(e.target.value);
              }}
              className="h-11 w-11 shrink-0 cursor-pointer rounded-md border border-input bg-background p-0.5 sm:h-10 sm:w-10"
              aria-label={t('colorPickerAriaLabel')}
            />
          </div>

          {recent.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs text-muted-ink">{t('recent')}</span>
              <div className="flex flex-wrap gap-1.5">
                {recent.map(h => (
                  <button
                    key={h}
                    data-ui="swatch"
                    type="button"
                    aria-label={h.toUpperCase()}
                    title={h.toUpperCase()}
                    onClick={() => {
                      setRaw(h);
                      commit(h);
                    }}
                    className="h-7 w-7 rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    style={{ backgroundColor: h }}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="outline" size="sm" type="button" onClick={() => setOpen(false)}>
              {t('done')}
            </Button>
          </div>
        </div>
      )}
      {hint ? <span className="text-xs text-muted-ink">{hint}</span> : null}
      {showContrastPreview && value ? (
        <ColorContrastPreview
          bg={value}
          theme={theme}
          pickedFg={previewFg}
          name={isToken ? plain(tokenName) : undefined}
        />
      ) : null}
    </div>
  );
}
