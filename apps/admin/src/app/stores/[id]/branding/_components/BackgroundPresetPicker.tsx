'use client';

import { useT } from '@/i18n/useT';
import { BACKGROUND_PRESET_OPTIONS, type StoreTheme } from './types';

interface BackgroundPresetPickerProps {
  theme: StoreTheme;
  onChange: (theme: StoreTheme) => void;
}

/**
 * 4-radio picker for the per-store homepage background preset (Sprint 1,
 * 2026-05-17). Sits below the Typography picker in the Theme tab. The
 * `brandColor` option derives its two tones from the merchant's chosen
 * `primaryColor` at storefront render time — admin shows live preview
 * swatches using inline HSL math against the current primaryColor so
 * the merchant sees what the section alternation will look like before
 * saving.
 *
 * This is ADDITIVE only — no existing branding form fields were
 * removed. Default value is `'none'` which preserves the current
 * single-surface visual.
 */
export function BackgroundPresetPicker({ theme, onChange }: BackgroundPresetPickerProps) {
  const t = useT('branding.theme.backgroundPreset');

  // Brand-color swatch preview: lift the merchant's primaryColor HSL to
  // 96% L (page) and 92% L (alt) with saturation capped at 25%. Mirrors
  // resolveBackgroundPreset in @force/shared so the preview matches the
  // storefront render exactly.
  const brandSwatches = (() => {
    const m = theme.primaryColor.match(/^\s*([\d.]+)\s+([\d.]+)%\s+[\d.]+%\s*$/);
    if (!m) return ['#FFFFFF', '#FAFAFA'] as const;
    const h = m[1];
    const cappedS = Math.min(Number(m[2]), 25);
    return [`hsl(${h} ${cappedS}% 96%)`, `hsl(${h} ${cappedS}% 92%)`] as const;
  })();

  const current = theme.backgroundPreset ?? 'none';

  return (
    <div className="rounded-lg border border-border p-4 bg-card">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {BACKGROUND_PRESET_OPTIONS.map(opt => {
          const isBrand = opt.value === 'brandColor';
          const swatches = isBrand ? brandSwatches : opt.swatches;
          const isSelected = current === opt.value;
          return (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                isSelected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-foreground/30'
              }`}
            >
              <input
                type="radio"
                name="backgroundPreset"
                value={opt.value}
                checked={isSelected}
                onChange={() => onChange({ ...theme, backgroundPreset: opt.value })}
                className="sr-only"
              />
              {/* Two-tone swatch preview */}
              <div className="flex h-10 w-14 shrink-0 overflow-hidden rounded border border-border/60">
                <div className="flex-1" style={{ backgroundColor: swatches[0] }} aria-hidden />
                <div className="flex-1" style={{ backgroundColor: swatches[1] }} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{t(`${opt.value}.label`)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t(`${opt.value}.hint`)}</p>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
