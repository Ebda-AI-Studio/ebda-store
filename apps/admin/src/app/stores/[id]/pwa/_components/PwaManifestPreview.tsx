'use client';

import { useT } from '@/i18n/useT';
import { DISPLAY_OPTIONS, ORIENTATION_OPTIONS, type PWASettings } from './types';

interface PwaManifestPreviewProps {
  settings: PWASettings;
  pwaEnabled: boolean;
  onChange: (settings: PWASettings) => void;
}

/**
 * Theme and appearance controls: theme color, background color,
 * display mode, and orientation — the manifest-facing preview.
 */
export function PwaManifestPreview({ settings, pwaEnabled, onChange }: PwaManifestPreviewProps) {
  const t = useT('pwa.manifest');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('themeColor')}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={settings.themeColor}
              onChange={e => onChange({ ...settings, themeColor: e.target.value })}
              className="w-10 h-10 rounded border border-border cursor-pointer"
              disabled={!pwaEnabled}
            />
            <input
              type="text"
              value={settings.themeColor}
              onChange={e => onChange({ ...settings, themeColor: e.target.value })}
              className="flex-1 px-3 py-2 border border-border rounded-lg text-sm uppercase"
              disabled={!pwaEnabled}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">{t('themeColorHelp')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('backgroundColor')}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={settings.backgroundColor}
              onChange={e => onChange({ ...settings, backgroundColor: e.target.value })}
              className="w-10 h-10 rounded border border-border cursor-pointer"
              disabled={!pwaEnabled}
            />
            <input
              type="text"
              value={settings.backgroundColor}
              onChange={e => onChange({ ...settings, backgroundColor: e.target.value })}
              className="flex-1 px-3 py-2 border border-border rounded-lg text-sm uppercase"
              disabled={!pwaEnabled}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">{t('backgroundColorHelp')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('display')}
          </label>
          <select
            value={settings.display}
            onChange={e =>
              onChange({ ...settings, display: e.target.value as PWASettings['display'] })
            }
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={!pwaEnabled}
          >
            {DISPLAY_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {t(`displayOptions.${opt.key}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('orientation')}
          </label>
          <select
            value={settings.orientation}
            onChange={e =>
              onChange({
                ...settings,
                orientation: e.target.value as PWASettings['orientation'],
              })
            }
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={!pwaEnabled}
          >
            {ORIENTATION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {t(`orientationOptions.${opt.key}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
