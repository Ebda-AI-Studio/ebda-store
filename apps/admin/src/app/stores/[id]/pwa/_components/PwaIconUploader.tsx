'use client';

import { useT } from '@/i18n/useT';
import type { PWASettings } from './types';

interface PwaIconUploaderProps {
  settings: PWASettings;
  pwaEnabled: boolean;
  onChange: (settings: PWASettings) => void;
}

/**
 * URL-based icon pickers for the 192x192, 512x512, and maskable icons,
 * with inline previews when a URL is provided.
 */
export function PwaIconUploader({ settings, pwaEnabled, onChange }: PwaIconUploaderProps) {
  const t = useT('pwa.icons');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('icon192')}
          </label>
          <input
            type="text"
            value={settings.icon192 || ''}
            onChange={e => onChange({ ...settings, icon192: e.target.value })}
            placeholder={t('urlPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={!pwaEnabled}
          />
          {settings.icon192 && (
            <img
              src={settings.icon192}
              alt={t('icon192Alt')}
              className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
            />
          )}
          <p className="text-xs text-muted-foreground mt-1">{t('icon192Help')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('icon512')}
          </label>
          <input
            type="text"
            value={settings.icon512 || ''}
            onChange={e => onChange({ ...settings, icon512: e.target.value })}
            placeholder={t('urlPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={!pwaEnabled}
          />
          {settings.icon512 && (
            <img
              src={settings.icon512}
              alt={t('icon512Alt')}
              className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
            />
          )}
          <p className="text-xs text-muted-foreground mt-1">{t('icon512Help')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('maskable')}
          </label>
          <input
            type="text"
            value={settings.maskableIcon || ''}
            onChange={e => onChange({ ...settings, maskableIcon: e.target.value })}
            placeholder={t('urlPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={!pwaEnabled}
          />
          {settings.maskableIcon && (
            <img
              src={settings.maskableIcon}
              alt={t('maskableAlt')}
              className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
            />
          )}
          <p className="text-xs text-muted-foreground mt-1">{t('maskableHelp')}</p>
        </div>
      </div>
    </div>
  );
}
