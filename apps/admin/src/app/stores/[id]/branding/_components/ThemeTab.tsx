'use client';

import { useT } from '@/i18n/useT';
import { BrandPreview } from './BrandPreview';
import { ColorPalettePicker } from './ColorPalettePicker';
import { TypographyPicker } from './TypographyPicker';
import { BackgroundPresetPicker } from './BackgroundPresetPicker';
import type { StoreBranding } from './types';

interface ThemeTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
}

/**
 * Theme & colors tab: primary/secondary palette, typography, and a live preview.
 */
export function ThemeTab({ branding, onChange }: ThemeTabProps) {
  const t = useT('branding.theme');

  return (
    <div className="bg-card rounded-xl border p-6 space-y-6">
      <ColorPalettePicker
        label={t('primaryColor')}
        hslValue={branding.theme.primaryColor}
        onChange={hsl => onChange({ ...branding, theme: { ...branding.theme, primaryColor: hsl } })}
        showPresets
        placeholder="#FF6600"
      />

      <ColorPalettePicker
        label={t('secondaryColor')}
        hslValue={branding.theme.secondaryColor}
        onChange={hsl =>
          onChange({ ...branding, theme: { ...branding.theme, secondaryColor: hsl } })
        }
        placeholder="#F3F4F6"
      />

      <TypographyPicker
        theme={branding.theme}
        onChange={theme => onChange({ ...branding, theme })}
      />

      {/* Sprint 1 (2026-05-17) — homepage section background preset.
          ADDITIVE: doesn't replace or remove any existing branding
          control. Defaults to 'none' so existing stores see no visual
          change until they explicitly pick a preset. */}
      <BackgroundPresetPicker
        theme={branding.theme}
        onChange={theme => onChange({ ...branding, theme })}
      />

      {/* Bucket C5 (2026-05-17) — opt-in brand pill on product cards. */}
      <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-foreground">
            {t('brandBadge.title')}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('brandBadge.hint')}</span>
        </span>
        <input
          type="checkbox"
          checked={branding.theme.showBrandBadge === true}
          onChange={e =>
            onChange({
              ...branding,
              theme: { ...branding.theme, showBrandBadge: e.target.checked },
            })
          }
          className="h-5 w-5 cursor-pointer accent-primary"
        />
      </label>

      <BrandPreview theme={branding.theme} />
    </div>
  );
}
