'use client';

interface LoyaltySettings {
  pointsPerDinar: number;
  signupBonus: number;
  referralBonus: number;
  reviewBonus: number;
  birthdayBonus: number;
  tiers: {
    bronze: { minPoints: number; multiplier: number };
    silver: { minPoints: number; multiplier: number };
    gold: { minPoints: number; multiplier: number };
    platinum: { minPoints: number; multiplier: number };
  };
  pointsValue: number;
  minRedeemPoints: number;
  maxRedeemPercentage: number;
  expirationMonths: number;
}

const TIER_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  bronze: { bg: 'bg-amber-100', text: 'text-amber-700', icon: 'bg-amber-500' },
  silver: { bg: 'bg-muted', text: 'text-foreground', icon: 'bg-muted-foreground' },
  gold: { bg: 'bg-yellow-100', text: 'text-yellow-700', icon: 'bg-yellow-500' },
  platinum: { bg: 'bg-purple-100', text: 'text-purple-700', icon: 'bg-purple-500' },
};

interface LoyaltySettingsPanelProps {
  settings: LoyaltySettings;
  loyaltyEnabled: boolean;
  saving: boolean;
  onSettingsChange: (settings: LoyaltySettings) => void;
  onSave: () => void;
}

export function LoyaltySettingsPanel({
  settings,
  loyaltyEnabled,
  saving,
  onSettingsChange,
  onSave,
}: LoyaltySettingsPanelProps) {
  return (
    <div className="space-y-6">
      {/* Earning Settings */}
      <div className="bg-card rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Point Earning</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Points per 1 KWD Spent
            </label>
            <input
              type="number"
              min="1"
              value={settings.pointsPerDinar}
              onChange={e =>
                onSettingsChange({ ...settings, pointsPerDinar: parseInt(e.target.value) || 1 })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Signup Bonus
            </label>
            <input
              type="number"
              min="0"
              value={settings.signupBonus}
              onChange={e =>
                onSettingsChange({ ...settings, signupBonus: parseInt(e.target.value) || 0 })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Referral Bonus
            </label>
            <input
              type="number"
              min="0"
              value={settings.referralBonus}
              onChange={e =>
                onSettingsChange({ ...settings, referralBonus: parseInt(e.target.value) || 0 })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Review Bonus
            </label>
            <input
              type="number"
              min="0"
              value={settings.reviewBonus}
              onChange={e =>
                onSettingsChange({ ...settings, reviewBonus: parseInt(e.target.value) || 0 })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Birthday Bonus
            </label>
            <input
              type="number"
              min="0"
              value={settings.birthdayBonus}
              onChange={e =>
                onSettingsChange({ ...settings, birthdayBonus: parseInt(e.target.value) || 0 })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
          </div>
        </div>
      </div>

      {/* Tier Settings */}
      <div className="bg-card rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Membership Tiers</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {(['bronze', 'silver', 'gold', 'platinum'] as const).map(tier => (
            <div key={tier} className={`p-4 rounded-lg ${TIER_COLORS[tier].bg}`}>
              <div className="flex items-center gap-2 mb-3">
                <div className={`w-3 h-3 rounded-full ${TIER_COLORS[tier].icon}`}></div>
                <h3 className={`font-semibold capitalize ${TIER_COLORS[tier].text}`}>{tier}</h3>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Min Points</label>
                  <input
                    type="number"
                    min="0"
                    value={settings.tiers[tier].minPoints}
                    onChange={e =>
                      onSettingsChange({
                        ...settings,
                        tiers: {
                          ...settings.tiers,
                          [tier]: {
                            ...settings.tiers[tier],
                            minPoints: parseInt(e.target.value) || 0,
                          },
                        },
                      })
                    }
                    className="w-full px-3 py-1.5 border border-border rounded text-sm focus:ring-2 focus:ring-primary focus:border-primary"
                    disabled={!loyaltyEnabled || tier === 'bronze'}
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Multiplier</label>
                  <input
                    type="number"
                    step="0.05"
                    min="1"
                    value={settings.tiers[tier].multiplier}
                    onChange={e =>
                      onSettingsChange({
                        ...settings,
                        tiers: {
                          ...settings.tiers,
                          [tier]: {
                            ...settings.tiers[tier],
                            multiplier: parseFloat(e.target.value) || 1,
                          },
                        },
                      })
                    }
                    className="w-full px-3 py-1.5 border border-border rounded text-sm focus:ring-2 focus:ring-primary focus:border-primary"
                    disabled={!loyaltyEnabled}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Redemption Settings */}
      <div className="bg-card rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Redemption</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Point Value (fils)
            </label>
            <input
              type="number"
              min="1"
              value={settings.pointsValue}
              onChange={e =>
                onSettingsChange({ ...settings, pointsValue: parseInt(e.target.value) || 1 })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
            <p className="text-xs text-muted-foreground mt-1">
              1 point = {settings.pointsValue} fils
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Min Points to Redeem
            </label>
            <input
              type="number"
              min="0"
              value={settings.minRedeemPoints}
              onChange={e =>
                onSettingsChange({ ...settings, minRedeemPoints: parseInt(e.target.value) || 0 })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Max % of Order
            </label>
            <input
              type="number"
              min="0"
              max="100"
              value={settings.maxRedeemPercentage}
              onChange={e =>
                onSettingsChange({
                  ...settings,
                  maxRedeemPercentage: parseInt(e.target.value) || 0,
                })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              Expiration (months)
            </label>
            <input
              type="number"
              min="0"
              value={settings.expirationMonths}
              onChange={e =>
                onSettingsChange({
                  ...settings,
                  expirationMonths: parseInt(e.target.value) || 0,
                })
              }
              className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={!loyaltyEnabled}
            />
            <p className="text-xs text-muted-foreground mt-1">0 = never expires</p>
          </div>
        </div>
      </div>

      {/* Save Button */}
      {loyaltyEnabled && (
        <div className="flex justify-end">
          <button
            onClick={onSave}
            disabled={saving}
            className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            )}
            Save Settings
          </button>
        </div>
      )}
    </div>
  );
}
