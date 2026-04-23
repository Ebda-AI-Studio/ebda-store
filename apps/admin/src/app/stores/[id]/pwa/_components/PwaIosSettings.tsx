'use client';

import { useT } from '@/i18n/useT';
import { IOS_STATUS_OPTIONS, type PWASettings } from './types';

interface PwaIosSettingsProps {
  settings: PWASettings;
  pwaEnabled: boolean;
  onChange: (settings: PWASettings) => void;
}

/**
 * iOS-specific manifest tweaks: Safari status bar style and splash screen color.
 */
export function PwaIosSettings({ settings, pwaEnabled, onChange }: PwaIosSettingsProps) {
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
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={!pwaEnabled}
          >
            {IOS_STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {t(`statusBarOptions.${opt.key}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('splashScreenColor')}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={settings.splashScreenColor}
              onChange={e => onChange({ ...settings, splashScreenColor: e.target.value })}
              className="w-10 h-10 rounded border border-border cursor-pointer"
              disabled={!pwaEnabled}
            />
            <input
              type="text"
              value={settings.splashScreenColor}
              onChange={e => onChange({ ...settings, splashScreenColor: e.target.value })}
              className="flex-1 px-3 py-2 border border-border rounded-lg text-sm uppercase"
              disabled={!pwaEnabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
