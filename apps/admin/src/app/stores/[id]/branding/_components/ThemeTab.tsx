'use client';

import { useT } from '@/i18n/useT';
import { BrandPreview } from './BrandPreview';
import { ColorPalettePicker } from './ColorPalettePicker';
import { TypographyPicker } from './TypographyPicker';
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

      <BrandPreview theme={branding.theme} />
    </div>
  );
}
