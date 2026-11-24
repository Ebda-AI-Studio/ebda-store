'use client';

import { useT } from '@/i18n/useT';
import type { TaxSettings } from './types';

interface TaxGeneralSettingsProps {
  settings: TaxSettings;
  /** True only when the store's VAT registration is verified (ruling TAX-2). */
  vatVerified: boolean;
  /** Server refusal of the last save (e.g. TAX_NOT_VERIFIED), shown under the toggle. */
  errorMessage?: string | null;
  savingSettings: boolean;
  onSettingsChange: (settings: TaxSettings) => void;
  onSaveSettings: (patch: Partial<TaxSettings>) => void;
}

/**
 * Top card: toggles for enabling tax and tax-inclusive pricing. Each control
 * auto-saves via `onSaveSettings` on change. The old "default tax rate" input
 * was removed (issue 2357): the charge never read it.
 */
export function TaxGeneralSettings({
  settings,
  vatVerified,
  errorMessage,
  savingSettings,
  onSettingsChange,
  onSaveSettings,
}: TaxGeneralSettingsProps) {
  const t = useT('tax.settings');

  return (
    <div className="bg-card rounded-md border border-border p-6 mb-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 data-setting-id="tax.enable" className="text-sm font-medium text-foreground">
              {t('enable.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('enable.description')}</p>
            {!vatVerified && (
              <p className="text-sm text-muted-foreground">
                {t('enable.needsVerification')}{' '}
                <a href="#vat-registration" className="text-primary hover:underline">
                  {t('enable.needsVerificationLink')}
                </a>
              </p>
            )}
            {errorMessage && (
              <p role="alert" className="text-sm text-destructive-ink">
                {errorMessage}
              </p>
            )}
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={settings.taxEnabled}
              onChange={e => {
                const newSettings = { ...settings, taxEnabled: e.target.checked };
                onSettingsChange(newSettings);
                onSaveSettings({ taxEnabled: e.target.checked });
              }}
              className="sr-only peer"
              disabled={savingSettings || (!vatVerified && !settings.taxEnabled)}
            />
            <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <h3 data-setting-id="tax.included" className="text-sm font-medium text-foreground">
              {t('included.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('included.description')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={settings.taxIncludedInPrice}
              onChange={e => {
                const newSettings = { ...settings, taxIncludedInPrice: e.target.checked };
                onSettingsChange(newSettings);
                onSaveSettings({ taxIncludedInPrice: e.target.checked });
              }}
              className="sr-only peer"
              disabled={savingSettings || !settings.taxEnabled}
            />
            <div
              className={`w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary ${!settings.taxEnabled ? 'opacity-50' : ''}`}
            ></div>
          </label>
        </div>
      </div>
    </div>
  );
}
