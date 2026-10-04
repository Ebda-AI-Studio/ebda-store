'use client';

import { Toggle } from '../../../../../components/Toggle';
import { ConnectionStatus } from '../../../../../components/ConnectionStatus';
import { useT } from '@/i18n/useT';
import { PickupAddressForm, type PickupAddress } from './PickupAddressForm';
import type { AramexConfig, TestStatus } from './types';

interface AramexCarrierCardProps {
  config: AramexConfig;
  saving: boolean;
  testing: boolean;
  settingDefault: boolean;
  testStatus: TestStatus;
  onConfigChange: (patch: Partial<AramexConfig>) => void;
  onPickupChange: (patch: Partial<PickupAddress>) => void;
  onSave: () => void;
  onTest: () => void;
  onSetDefault: () => void;
}

/**
 * Aramex carrier settings card. Fields: accountNumber, accountPin,
 * accountEntity, accountCountryCode, username, password, the sandbox switch, the
 * "COD in EGP confirmed" switch (Aramex COD is refused until the merchant has Aramex's
 * written confirmation) and the shared pickup-address block. PIN and password are masked.
 */
export function AramexCarrierCard({
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
}: AramexCarrierCardProps) {
  const t = useT('shipping.carriers.aramex');
  const tShared = useT('shipping.carriers.shared');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-destructive/10 rounded-xl flex items-center justify-center">
            <svg
              className="w-5 h-5 text-destructive"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
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
            {t('fields.accountNumber')}
          </label>
          <input
            type="text"
            value={config.accountNumber}
            onChange={e => onConfigChange({ accountNumber: e.target.value })}
            placeholder={t('placeholders.accountNumber')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.accountPin')}
          </label>
          <input
            type="password"
            autoComplete="off"
            value={config.accountPin}
            onChange={e => onConfigChange({ accountPin: e.target.value })}
            placeholder={t('placeholders.accountPin')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.accountEntity')}
          </label>
          <input
            type="text"
            value={config.accountEntity}
            onChange={e => onConfigChange({ accountEntity: e.target.value })}
            placeholder={t('placeholders.accountEntity')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.accountCountryCode')}
          </label>
          <input
            type="text"
            value={config.accountCountryCode}
            onChange={e => onConfigChange({ accountCountryCode: e.target.value })}
            placeholder={t('placeholders.accountCountryCode')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.username')}
          </label>
          <input
            type="text"
            value={config.username}
            onChange={e => onConfigChange({ username: e.target.value })}
            placeholder={t('placeholders.username')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.password')}
          </label>
          <input
            type="password"
            autoComplete="off"
            value={config.password}
            onChange={e => onConfigChange({ password: e.target.value })}
            placeholder={t('placeholders.password')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">{t('fields.sandbox')}</span>
          <Toggle checked={config.sandbox} onChange={val => onConfigChange({ sandbox: val })} />
        </label>
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">
              {t('fields.codEgpConfirmed')}
            </span>
            <Toggle
              checked={config.codEgpConfirmed}
              onChange={val => onConfigChange({ codEgpConfirmed: val })}
            />
          </label>
          <p className="mt-2 text-xs text-muted-foreground">{t('codNotice')}</p>
        </div>
      </div>

      <PickupAddressForm value={config.pickup} onChange={onPickupChange} />

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
        <button
          type="button"
          onClick={onTest}
          disabled={testing}
          className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
        >
          {tShared('testConnection')}
        </button>
        {!config.isDefault && (
          <button
            type="button"
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
