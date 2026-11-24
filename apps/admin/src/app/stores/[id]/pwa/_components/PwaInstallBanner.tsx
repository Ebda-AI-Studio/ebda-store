'use client';

import { useT } from '@/i18n/useT';
import type { PWASettings } from './types';

interface PwaInstallBannerProps {
  settings: PWASettings;
  pwaEnabled: boolean;
  onChange: (settings: PWASettings) => void;
}

interface ToggleRowProps {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}

function ToggleRow({ title, description, checked, disabled, onToggle }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
      <div>
        <h3 className="font-medium text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <label className="relative inline-flex items-center cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onToggle(e.target.checked)}
          className="sr-only peer"
          disabled={disabled}
        />
        <div
          className={`w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary ${disabled ? 'opacity-50' : ''}`}
        ></div>
      </label>
    </div>
  );
}

/**
 * Feature toggles: install prompt, offline support, and push notifications.
 * Owns the "install banner" affordance that surfaces the add-to-home-screen UX.
 */
export function PwaInstallBanner({ settings, pwaEnabled, onChange }: PwaInstallBannerProps) {
  const t = useT('pwa.features');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="space-y-4">
        <ToggleRow
          title={t('installPrompt.title')}
          description={t('installPrompt.description')}
          checked={settings.installPromptEnabled}
          disabled={!pwaEnabled}
          onToggle={next => onChange({ ...settings, installPromptEnabled: next })}
        />

        {/* Offline-support toggle removed: the storefront service worker has no
            fetch handler and caches nothing (apps/web/src/lib/pwa/sw-source.ts is push-only),
            so this toggle was a no-op that promised offline caching we don't do. */}
        <ToggleRow
          title={t('push.title')}
          description={t('push.description')}
          checked={settings.pushNotificationsEnabled}
          disabled={!pwaEnabled}
          onToggle={next => onChange({ ...settings, pushNotificationsEnabled: next })}
        />
      </div>
    </div>
  );
}
