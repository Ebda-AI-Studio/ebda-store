'use client';

import { useT } from '@/i18n/useT';
import { BORDER_RADIUS_OPTIONS, FONT_OPTIONS, type StoreTheme } from './types';

interface TypographyPickerProps {
  theme: StoreTheme;
  onChange: (theme: StoreTheme) => void;
}

/**
 * Typography controls: font family and border-radius scale selects.
 */
export function TypographyPicker({ theme, onChange }: TypographyPickerProps) {
  const t = useT('branding.theme');
  const tFonts = useT('branding.theme.fonts');
  const tRadius = useT('branding.theme.radius');

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">{t('fontFamily')}</label>
        <select
          value={theme.fontFamily}
          onChange={e => onChange({ ...theme, fontFamily: e.target.value })}
          className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
        >
          {FONT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>
              {tFonts(opt.key)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          {t('borderRadius')}
        </label>
        <select
          value={theme.borderRadius}
          onChange={e => onChange({ ...theme, borderRadius: e.target.value })}
          className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
        >
          {BORDER_RADIUS_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>
              {tRadius(opt.key)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
