'use client';

import { useT } from '@/i18n/useT';
import { TIER_COLORS, TIER_KEYS, type LoyaltySettings, type TierKey } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface TierSettingsProps {
  settings: LoyaltySettings;
  disabled: boolean;
  onChange: (patch: Partial<LoyaltySettings>) => void;
}

/**
 * Configures membership tiers (bronze, silver, gold, platinum) with their
 * minimum point thresholds and earn multipliers. Bronze's minPoints is locked
 * because it is the entry tier.
 */
export function TierSettings({ settings, disabled, onChange }: TierSettingsProps) {
  const t = useT('loyalty.tiers');

  const updateTier = (tier: TierKey, patch: Partial<LoyaltySettings['tiers'][TierKey]>) => {
    onChange({
      tiers: {
        ...settings.tiers,
        [tier]: { ...settings.tiers[tier], ...patch },
      },
    });
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {TIER_KEYS.map(tier => (
          <div key={tier} className={`p-4 rounded-lg ${TIER_COLORS[tier].bg}`}>
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-3 h-3 rounded-full ${TIER_COLORS[tier].icon}`}></div>
              <h3 className={`font-semibold ${TIER_COLORS[tier].text}`}>{t(tier)}</h3>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-muted-foreground mb-1">{t('minPoints')}</label>
                <input
                  type="number"
                  min="0"
                  value={settings.tiers[tier].minPoints}
                  onChange={e => updateTier(tier, { minPoints: parseInt(e.target.value) || 0 })}
                  className={FIELD_CLASSES}
                  disabled={disabled || tier === 'bronze'}
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">
                  {t('multiplier')}
                </label>
                <input
                  type="number"
                  step="0.05"
                  min="1"
                  value={settings.tiers[tier].multiplier}
                  onChange={e => updateTier(tier, { multiplier: parseFloat(e.target.value) || 1 })}
                  className={FIELD_CLASSES}
                  disabled={disabled}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
