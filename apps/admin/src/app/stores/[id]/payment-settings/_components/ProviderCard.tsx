'use client';

import { useState } from 'react';
import { Alert } from '../../../../../components/Alert';
import { useT } from '@/i18n/useT';

function getWebhookUrl(providerId: string): string {
  const apiBase = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
  const base = apiBase.endsWith('/api/v1') ? apiBase : `${apiBase}/api/v1`;
  return `${base}/webhooks/payment/${providerId}`;
}

export interface StorePaymentConfig {
  id?: string;
  provider: string;
  isEnabled: boolean;
  apiKey: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  merchantId: string | null;
  /**
   * #2010 — set by the API when a key is saved but was stored before the
   * save-time fingerprint existed, so it can only show `****`.
   */
  apiKeyFingerprintMissing?: boolean;
  merchantIdFingerprintMissing?: boolean;
  testMode: boolean;
  displayName?: string | null;
  displayNameAr?: string | null;
  fixedFee?: number;
}

export type ProviderKind = 'gateway' | 'cod';

export interface ProviderDef {
  id: string;
  name: string;
  nameAr: string;
  color: string;
  kind: ProviderKind;
}

export interface ProviderSaveMessage {
  type: 'success' | 'error';
  text: string;
}

interface ProviderCardProps {
  provider: ProviderDef;
  form: StorePaymentConfig;
  expanded: boolean;
  saving: boolean;
  message?: ProviderSaveMessage;
  onToggle: (enabled: boolean) => void;
  onToggleExpanded: () => void;
  onUpdateField: (field: keyof StorePaymentConfig, value: string | number | boolean | null) => void;
  onSave: () => void;
}

export function ProviderCard({
  provider,
  form,
  expanded,
  saving,
  message,
  onToggle,
  onToggleExpanded,
  onUpdateField,
  onSave,
}: ProviderCardProps) {
  const t = useT('paymentSettings');

  return (
    <div
      className={`rounded-xl border bg-card shadow-sm overflow-hidden transition-all ${
        form.isEnabled ? 'border-s-4' : ''
      }`}
      style={form.isEnabled ? { borderInlineStartColor: provider.color } : undefined}
    >
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-white text-sm font-bold"
            style={{ backgroundColor: provider.color }}
          >
            {provider.id[0].toUpperCase()}
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{provider.name}</h3>
            <p className="text-xs text-muted-foreground">{provider.nameAr}</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {form.isEnabled ? t('toggle.enabled') : t('toggle.disabled')}
            </span>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={form.isEnabled}
                onChange={e => onToggle(e.target.checked)}
                disabled={saving}
                className="sr-only peer"
              />
              <div className="peer h-6 w-11 rounded-full bg-muted after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-500 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-400/30 peer-disabled:opacity-50" />
            </label>
          </div>

          <button
            type="button"
            onClick={onToggleExpanded}
            className="flex items-center gap-1 px-3 py-1.5 text-sm text-muted-foreground border border-border rounded-lg hover:bg-muted transition-colors"
          >
            {t('configure')}
            <svg
              className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t bg-muted p-6 space-y-5">
          {provider.kind === 'cod' ? (
            <CodFields form={form} onUpdateField={onUpdateField} />
          ) : (
            <GatewayFields providerId={provider.id} form={form} onUpdateField={onUpdateField} />
          )}

          {message && (
            <Alert
              compact
              variant={message.type === 'success' ? 'success' : 'destructive'}
              description={message.text}
            />
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="px-6 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
            >
              {saving ? t('saving') : t('save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CodFields({
  form,
  onUpdateField,
}: {
  form: StorePaymentConfig;
  onUpdateField: (field: keyof StorePaymentConfig, value: string | number | boolean | null) => void;
}) {
  const t = useT('paymentSettings.cod');

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('displayNameLabel')}
          </label>
          <input
            type="text"
            value={form.displayName || ''}
            onChange={e => onUpdateField('displayName', e.target.value)}
            placeholder={t('displayNamePlaceholder')}
            className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('displayNameArLabel')}
          </label>
          <input
            type="text"
            lang="ar"
            dir="rtl"
            value={form.displayNameAr || ''}
            onChange={e => onUpdateField('displayNameAr', e.target.value)}
            placeholder={t('displayNameArPlaceholder')}
            className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('fixedFeeLabel')}
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={0}
              step={0.001}
              value={((Number(form.fixedFee) || 0) / 1000).toFixed(3)}
              onChange={e =>
                onUpdateField(
                  'fixedFee',
                  Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 1000))
                )
              }
              placeholder={t('fixedFeePlaceholder')}
              className="w-40 rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('fixedFeeHelpPrefix')} <strong>{t('fixedFeeHelpZero')}</strong>{' '}
            {t('fixedFeeHelpSuffix')}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
        {t('infoBanner')}
      </div>
    </>
  );
}

function GatewayFields({
  providerId,
  form,
  onUpdateField,
}: {
  providerId: string;
  form: StorePaymentConfig;
  onUpdateField: (field: keyof StorePaymentConfig, value: string | number | boolean | null) => void;
}) {
  const t = useT('paymentSettings.gateway');
  const [copied, setCopied] = useState(false);
  const webhookUrl = getWebhookUrl(providerId);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (e.g. insecure context, iframe) — input is
      // still focus-to-select so the merchant can copy manually
    }
  };

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('apiKeyLabel')}
          </label>
          <input
            type="password"
            value={form.apiKey || ''}
            onChange={e => onUpdateField('apiKey', e.target.value)}
            placeholder={t('apiKeyPlaceholder')}
            className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <SavedCredentialHint value={form.apiKey} missing={form.apiKeyFingerprintMissing} />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('secretKeyLabel')}
          </label>
          <input
            type="password"
            value={form.secretKey || ''}
            onChange={e => onUpdateField('secretKey', e.target.value)}
            placeholder={t('secretKeyPlaceholder')}
            className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('webhookSecretLabel')}
          </label>
          <input
            type="password"
            value={form.webhookSecret || ''}
            onChange={e => onUpdateField('webhookSecret', e.target.value)}
            placeholder={t('webhookSecretPlaceholder')}
            className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('merchantIdLabel')}
          </label>
          <input
            type="text"
            value={form.merchantId || ''}
            onChange={e => onUpdateField('merchantId', e.target.value)}
            placeholder={t('merchantIdPlaceholder')}
            className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <SavedCredentialHint
            value={form.merchantId}
            missing={form.merchantIdFingerprintMissing}
          />
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
        <p className="mb-1 font-medium text-blue-900">{t('webhookUrlLabel')}</p>
        <p className="mb-2 text-xs text-blue-700">{t('webhookUrlDescription')}</p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={webhookUrl}
            readOnly
            onFocus={e => e.currentTarget.select()}
            className="flex-1 rounded border border-blue-300 bg-white px-3 py-1.5 font-mono text-xs text-blue-900 focus:border-blue-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="rounded border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
          >
            {copied ? t('webhookUrlCopied') : t('webhookUrlCopy')}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <label className="relative inline-flex cursor-pointer items-center">
          <input
            type="checkbox"
            checked={form.testMode}
            onChange={e => onUpdateField('testMode', e.target.checked)}
            className="sr-only peer"
          />
          <div className="peer h-5 w-9 rounded-full bg-muted after:absolute after:start-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-border after:bg-white after:transition-all after:content-[''] peer-checked:bg-amber-500 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white peer-focus:outline-none" />
        </label>
        <div>
          <p className="text-sm font-medium text-amber-800">
            {form.testMode ? t('testModeOn') : t('testModeOff')}
          </p>
          <p className="text-xs text-amber-700">
            {form.testMode ? t('testModeDescriptionOn') : t('testModeDescriptionOff')}
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * Which credential is saved (#2010). The API returns `****` + the last 4
 * characters of the plaintext, captured at save time — never decrypted on
 * read. The api-key input is a password field, so the fingerprint is shown
 * here as text. Only while the field still holds the saved (masked) value:
 * once the merchant types a new key, the hint no longer describes the input.
 */
function SavedCredentialHint({ value, missing }: { value: string | null; missing?: boolean }) {
  const t = useT('paymentSettings.gateway');
  if (!value || !value.startsWith('****')) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {missing ? t('savedResaveToShow') : t('savedValue', { value })}
    </p>
  );
}
