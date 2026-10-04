'use client';

import { Toggle } from '../../../../../components/Toggle';
import { ConnectionStatus } from '../../../../../components/ConnectionStatus';
import { useT } from '@/i18n/useT';
import { PickupAddressForm, type PickupAddress } from './PickupAddressForm';
import type { BostaConfig, TestStatus } from './types';

interface BostaCarrierCardProps {
  config: BostaConfig;
  saving: boolean;
  testing: boolean;
  settingDefault: boolean;
  rotating: boolean;
  testStatus: TestStatus;
  onConfigChange: (patch: Partial<BostaConfig>) => void;
  onPickupChange: (patch: Partial<PickupAddress>) => void;
  onSave: () => void;
  onTest: () => void;
  onSetDefault: () => void;
  onRotateSecret: () => void;
}

/**
 * Bosta carrier settings card: API key, the Bosta pickup location id, the sandbox switch and the
 * shared pickup-address block. The tracking callback is set by us on every delivery with a secret
 * of its own (nothing to copy into Bosta); "Rotate" replaces that secret if it ever leaks.
 */
export function BostaCarrierCard({
  config,
  saving,
  testing,
  settingDefault,
  rotating,
  testStatus,
  onConfigChange,
  onPickupChange,
  onSave,
  onTest,
  onSetDefault,
  onRotateSecret,
}: BostaCarrierCardProps) {
  const t = useT('shipping.carriers.bosta');
  const tShared = useT('shipping.carriers.shared');
  const input =
    'w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary';
  const button =
    'px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium';

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
            {config.isDefault && (
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary-ink">
                {tShared('defaultBadge')}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {config.enabled ? tShared('enabled') : tShared('disabled')}
          </span>
          <Toggle checked={config.enabled} onChange={val => onConfigChange({ enabled: val })} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.apiKey')}
          </label>
          <input
            type="password"
            autoComplete="off"
            value={config.apiKey}
            onChange={e => onConfigChange({ apiKey: e.target.value })}
            placeholder={t('placeholders.apiKey')}
            className={input}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.businessLocationId')}
          </label>
          <input
            type="text"
            value={config.businessLocationId}
            onChange={e => onConfigChange({ businessLocationId: e.target.value })}
            placeholder={t('placeholders.businessLocationId')}
            className={input}
          />
        </div>
      </div>

      <label className="mt-4 flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">{t('fields.sandbox')}</span>
        <Toggle checked={config.sandbox} onChange={val => onConfigChange({ sandbox: val })} />
      </label>

      <PickupAddressForm value={config.pickup} onChange={onPickupChange} />

      <p className="mt-4 text-xs text-muted-foreground">{t('webhookNotice')}</p>

      <div className="flex items-center gap-3 mt-4 flex-wrap">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
        >
          {saving && (
            <span className="animate-spin inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
          )}
          {tShared('save')}
        </button>
        <button type="button" onClick={onTest} disabled={testing} className={button}>
          {tShared('testConnection')}
        </button>
        {!config.isDefault && (
          <button type="button" onClick={onSetDefault} disabled={settingDefault} className={button}>
            {tShared('setAsDefault')}
          </button>
        )}
        <button type="button" onClick={onRotateSecret} disabled={rotating} className={button}>
          {t('rotateSecret')}
        </button>
        <ConnectionStatus status={testStatus} />
      </div>
    </div>
  );
}
