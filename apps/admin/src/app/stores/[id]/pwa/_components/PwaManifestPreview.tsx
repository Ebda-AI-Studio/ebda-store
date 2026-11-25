'use client';

import { useT } from '@/i18n/useT';
import type { StoreTheme } from '@ebda/shared';
import { ColorField } from '../../../../../components/ColorField';
import { DISPLAY_OPTIONS, ORIENTATION_OPTIONS, type PWASettings } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface PwaManifestPreviewProps {
  settings: PWASettings;
  pwaEnabled: boolean;
  onChange: (settings: PWASettings) => void;
  /** Store theme — passed through so ColorField can offer brand-token presets. */
  theme?: StoreTheme;
}

/**
 * Theme and appearance controls: theme color, background color,
 * display mode, and orientation — the manifest-facing preview.
 */
export function PwaManifestPreview({
  settings,
  pwaEnabled,
  onChange,
  theme,
}: PwaManifestPreviewProps) {
  const t = useT('pwa.manifest');

  return (
    <div className="bg-card rounded-md border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className={pwaEnabled ? '' : 'opacity-50 pointer-events-none'}>
          <ColorField
            label={t('themeColor')}
            value={settings.themeColor}
            onChange={v => onChange({ ...settings, themeColor: v || '#000000' })}
            theme={theme}
            hint={t('themeColorHelp')}
            showContrastPreview={false}
          />
        </div>
        <div className={pwaEnabled ? '' : 'opacity-50 pointer-events-none'}>
          <ColorField
            label={t('backgroundColor')}
            value={settings.backgroundColor}
            onChange={v => onChange({ ...settings, backgroundColor: v || '#ffffff' })}
            theme={theme}
            hint={t('backgroundColorHelp')}
            showContrastPreview={false}
          />
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
            className={FIELD_CLASSES}
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
            className={FIELD_CLASSES}
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
