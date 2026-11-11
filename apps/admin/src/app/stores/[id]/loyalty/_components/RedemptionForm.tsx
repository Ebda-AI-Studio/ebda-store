'use client';

import { useT } from '@/i18n/useT';
import type { LoyaltySettings } from './types';

import { minorToDecimalString, roundToMinor } from '@ebda/shared';
import { FIELD_CLASSES } from '@/components/ui/tokens';
interface RedemptionFormProps {
  settings: LoyaltySettings;
  disabled: boolean;
  onChange: (patch: Partial<LoyaltySettings>) => void;
}

/**
 * Configures how points convert back to value at checkout: point value in
 * piastres, minimum redeem threshold, max percentage of order covered by points,
 * and expiration window.
 */
export function RedemptionForm({ settings, disabled, onChange }: RedemptionFormProps) {
  const t = useT('loyalty.redemption');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('pointValue')}
          </label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={minorToDecimalString(settings.pointsValue)}
            onChange={e => onChange({ pointsValue: roundToMinor(parseFloat(e.target.value) || 0) })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t('pointValueHint', { value: minorToDecimalString(settings.pointsValue) })}
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('minRedeem')}
          </label>
          <input
            type="number"
            min="0"
            value={settings.minRedeemPoints}
            onChange={e => onChange({ minRedeemPoints: parseInt(e.target.value) || 0 })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('maxPercent')}
          </label>
          <input
            type="number"
            min="0"
            max="100"
            value={settings.maxRedeemPercentage}
            onChange={e => onChange({ maxRedeemPercentage: parseInt(e.target.value) || 0 })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('expirationMonths')}
          </label>
          <input
            type="number"
            min="0"
            value={settings.expirationMonths}
            onChange={e => onChange({ expirationMonths: parseInt(e.target.value) || 0 })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground mt-1">{t('expirationHint')}</p>
        </div>
      </div>
    </div>
  );
}
