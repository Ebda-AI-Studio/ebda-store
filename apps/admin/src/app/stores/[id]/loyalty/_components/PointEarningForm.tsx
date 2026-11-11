'use client';

import { useT } from '@/i18n/useT';
import type { LoyaltySettings } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface PointEarningFormProps {
  settings: LoyaltySettings;
  disabled: boolean;
  onChange: (patch: Partial<LoyaltySettings>) => void;
}

/**
 * Configures how many points customers earn from various actions: purchases,
 * signup, referrals, reviews, and birthdays. Inputs are disabled when the
 * loyalty program is off.
 */
export function PointEarningForm({ settings, disabled, onChange }: PointEarningFormProps) {
  const t = useT('loyalty.earning');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('pointsPerMajorUnit')}
          </label>
          <input
            type="number"
            min="1"
            value={settings.pointsPerMajorUnit}
            onChange={e => onChange({ pointsPerMajorUnit: parseInt(e.target.value) || 1 })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('signupBonus')}
          </label>
          <input
            type="number"
            min="0"
            value={settings.signupBonus}
            onChange={e => onChange({ signupBonus: parseInt(e.target.value) || 0 })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('referralBonus')}
          </label>
          <input
            type="number"
            min="0"
            value={settings.referralBonus}
            onChange={e => onChange({ referralBonus: parseInt(e.target.value) || 0 })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('reviewBonus')}
          </label>
          <input
            type="number"
            min="0"
            value={settings.reviewBonus}
            onChange={e => onChange({ reviewBonus: parseInt(e.target.value) || 0 })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('birthdayBonus')}
          </label>
          <input
            type="number"
            min="0"
            value={settings.birthdayBonus}
            onChange={e => onChange({ birthdayBonus: parseInt(e.target.value) || 0 })}
            className={FIELD_CLASSES}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}
