'use client';

import { useT } from '@/i18n/useT';
import type { PWASettings } from './types';

interface PwaBrandingProps {
  settings: PWASettings;
  pwaEnabled: boolean;
  onChange: (settings: PWASettings) => void;
}

/**
 * App identity form: names (EN/AR), short names (EN/AR), descriptions (EN/AR).
 */
export function PwaBranding({ settings, pwaEnabled, onChange }: PwaBrandingProps) {
  const t = useT('pwa.branding');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label
            data-setting-id="pwa.app-name"
            className="block text-sm font-medium text-muted-foreground mb-2"
          >
            {t('appName')}
          </label>
          <input
            type="text"
            value={settings.appName}
            onChange={e => onChange({ ...settings, appName: e.target.value })}
            placeholder={t('appNamePlaceholder')}
            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={!pwaEnabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('appNameAr')}
          </label>
          <input
            type="text"
            value={settings.appNameAr || ''}
            onChange={e => onChange({ ...settings, appNameAr: e.target.value })}
            placeholder={t('appNameArPlaceholder')}
            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            lang="ar"
            dir="rtl"
            disabled={!pwaEnabled}
          />
        </div>
        <div>
          <label
            data-setting-id="pwa.short-name"
            className="block text-sm font-medium text-muted-foreground mb-2"
          >
            {t('shortName')}
          </label>
          <input
            type="text"
            maxLength={12}
            value={settings.shortName}
            onChange={e => onChange({ ...settings, shortName: e.target.value })}
            placeholder={t('shortNamePlaceholder')}
            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={!pwaEnabled}
          />
          <p className="text-xs text-muted-foreground mt-1">{t('shortNameHelp')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('shortNameAr')}
          </label>
          <input
            type="text"
            maxLength={12}
            value={settings.shortNameAr || ''}
            onChange={e => onChange({ ...settings, shortNameAr: e.target.value })}
            placeholder={t('shortNameArPlaceholder')}
            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            lang="ar"
            dir="rtl"
            disabled={!pwaEnabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('description')}
          </label>
          <textarea
            value={settings.description}
            onChange={e => onChange({ ...settings, description: e.target.value })}
            placeholder={t('descriptionPlaceholder')}
            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            rows={2}
            disabled={!pwaEnabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('descriptionAr')}
          </label>
          <textarea
            value={settings.descriptionAr || ''}
            onChange={e => onChange({ ...settings, descriptionAr: e.target.value })}
            placeholder={t('descriptionArPlaceholder')}
            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            rows={2}
            lang="ar"
            dir="rtl"
            disabled={!pwaEnabled}
          />
        </div>
      </div>
    </div>
  );
}
