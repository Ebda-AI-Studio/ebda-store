'use client';

import { Toggle } from '../../../../../components/Toggle';
import { ConnectionStatus } from '../../../../../components/ConnectionStatus';
import { useT } from '@/i18n/useT';
import { PickupAddressForm, type PickupAddress } from './PickupAddressForm';
import type { ICarryConfig, TestStatus } from './types';

interface ICarryCarrierCardProps {
  config: ICarryConfig;
  saving: boolean;
  testing: boolean;
  settingDefault: boolean;
  testStatus: TestStatus;
  onConfigChange: (patch: Partial<ICarryConfig>) => void;
  onPickupChange: (patch: Partial<PickupAddress>) => void;
  onSave: () => void;
  onTest: () => void;
  onSetDefault: () => void;
}

/**
 * iCarry carrier settings card. Fields: apiKey, merchantId, and the shared
 * pickup-address block. API key is masked via type=password.
 */
export function ICarryCarrierCard({
  config,
  saving,
  testing,
  settingDefault,
  testStatus,
  onConfigChange,
  onPickupChange,
  onSave,
  onTest,
  onSetDefault,
}: ICarryCarrierCardProps) {
  const t = useT('shipping.carriers.icarry');
  const tShared = useT('shipping.carriers.shared');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-cyan-100 rounded-xl flex items-center justify-center">
            <svg
              className="w-5 h-5 text-cyan-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
              />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
              {config.isDefault && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                  {tShared('defaultBadge')}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
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
            value={config.apiKey}
            onChange={e => onConfigChange({ apiKey: e.target.value })}
            placeholder={t('placeholders.apiKey')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.merchantId')}
          </label>
          <input
            type="text"
            value={config.merchantId}
            onChange={e => onConfigChange({ merchantId: e.target.value })}
            placeholder={t('placeholders.merchantId')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
      </div>

      <PickupAddressForm value={config.pickup} onChange={onPickupChange} />

      <div className="flex items-center gap-3 mt-4 flex-wrap">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
        >
          {saving && (
            <span className="animate-spin inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
          )}
          {tShared('save')}
        </button>
        <button
          onClick={onTest}
          disabled={testing}
          className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
        >
          {tShared('testConnection')}
        </button>
        {!config.isDefault && (
          <button
            onClick={onSetDefault}
            disabled={settingDefault}
            className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
          >
            {settingDefault && (
              <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
            )}
            {tShared('setAsDefault')}
          </button>
        )}
        <ConnectionStatus status={testStatus} />
      </div>
    </div>
  );
}
