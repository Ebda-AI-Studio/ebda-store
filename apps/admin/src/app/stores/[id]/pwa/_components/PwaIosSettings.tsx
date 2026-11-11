'use client';

import { useT } from '@/i18n/useT';
import type { StoreTheme } from '@ebda/shared';
import { ColorField } from '../../../../../components/ColorField';
import { IOS_STATUS_OPTIONS, type PWASettings } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface PwaIosSettingsProps {
  settings: PWASettings;
  pwaEnabled: boolean;
  onChange: (settings: PWASettings) => void;
  /** Store theme — passed through so ColorField can offer brand-token presets. */
  theme?: StoreTheme;
}

/**
 * iOS-specific manifest tweaks: Safari status bar style and splash screen color.
 */
export function PwaIosSettings({ settings, pwaEnabled, onChange, theme }: PwaIosSettingsProps) {
  const t = useT('pwa.ios');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('statusBarStyle')}
          </label>
          <select
            value={settings.iosStatusBarStyle}
            onChange={e =>
              onChange({
                ...settings,
                iosStatusBarStyle: e.target.value as PWASettings['iosStatusBarStyle'],
              })
            }
            className={FIELD_CLASSES}
            disabled={!pwaEnabled}
          >
            {IOS_STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {t(`statusBarOptions.${opt.key}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={pwaEnabled ? '' : 'opacity-50 pointer-events-none'}>
          <ColorField
            label={t('splashScreenColor')}
            value={settings.splashScreenColor}
            onChange={v => onChange({ ...settings, splashScreenColor: v || '#ffffff' })}
            theme={theme}
            showContrastPreview={false}
          />
        </div>
      </div>
    </div>
  );
}
