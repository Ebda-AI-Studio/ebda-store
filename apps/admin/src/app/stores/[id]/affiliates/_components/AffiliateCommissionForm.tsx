'use client';

import { useT } from '@/i18n/useT';
import { minorToMajor } from '@/lib/format';
import type { AffiliateConfig } from './types';

import { roundToMinor } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
interface AffiliateCommissionFormProps {
  config: AffiliateConfig;
  saving: boolean;
  onConfigChange: (config: AffiliateConfig) => void;
  onSave: () => void;
}

/**
 * Configuration tab for the affiliate program: commission rate, cookie
 * duration, minimum payout, and program toggles (auto-approve, public signup).
 */
export function AffiliateCommissionForm({
  config,
  saving,
  onConfigChange,
  onSave,
}: AffiliateCommissionFormProps) {
  const t = useT('affiliates.config');

  return (
    <div className="space-y-6">
      <div className="bg-card rounded-md border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">{t('commissionSection')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('fields.defaultCommissionRate')}
            </label>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={config.defaultCommissionRate}
              onChange={e =>
                onConfigChange({
                  ...config,
                  defaultCommissionRate: parseFloat(e.target.value) || 0,
                })
              }
              className={FIELD_CLASSES}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('fields.cookieDurationDays')}
            </label>
            <input
              type="number"
              min="1"
              max="365"
              value={config.cookieDurationDays}
              onChange={e =>
                onConfigChange({
                  ...config,
                  cookieDurationDays: parseInt(e.target.value) || 30,
                })
              }
              className={FIELD_CLASSES}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('fields.minPayoutAmount')}
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={minorToMajor(config.minPayoutAmount)}
              onChange={e =>
                onConfigChange({
                  ...config,
                  minPayoutAmount: roundToMinor(parseFloat(e.target.value) || 0),
                })
              }
              className={FIELD_CLASSES}
            />
          </div>
        </div>
      </div>

      <div className="bg-card rounded-md border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">{t('optionsSection')}</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-foreground">{t('toggles.autoApprove.title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('toggles.autoApprove.description')}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={config.autoApprove}
              type="button"
              onClick={() => onConfigChange({ ...config, autoApprove: !config.autoApprove })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                config.autoApprove ? 'bg-primary' : 'bg-border'
              }`}
              aria-label={t('toggles.autoApprove.title')}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  config.autoApprove
                    ? 'translate-x-6 rtl:-translate-x-6'
                    : 'translate-x-1 rtl:-translate-x-1'
                }`}
              />
            </button>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-4">
            <div>
              <p className="font-medium text-foreground">{t('toggles.publicSignup.title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('toggles.publicSignup.description')}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={config.publicSignupEnabled}
              type="button"
              onClick={() =>
                onConfigChange({ ...config, publicSignupEnabled: !config.publicSignupEnabled })
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                config.publicSignupEnabled ? 'bg-primary' : 'bg-border'
              }`}
              aria-label={t('toggles.publicSignup.title')}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  config.publicSignupEnabled
                    ? 'translate-x-6 rtl:-translate-x-6'
                    : 'translate-x-1 rtl:-translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="default" size="md" type="button" onClick={onSave} disabled={saving}>
          {saving && (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-foreground" />
          )}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
