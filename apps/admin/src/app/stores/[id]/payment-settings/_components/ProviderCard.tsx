'use client';

import { Alert } from '../../../../../components/Alert';
import { useLocale } from 'next-intl';
import { ProviderLogo } from '@/components/ProviderLogo';
import { useT } from '@/i18n/useT';

import { INSTAPAY_DEFAULT_EXPIRY_HOURS, minorToDecimalString, roundToMinor } from '@ebda/shared';
import { Button } from '@/components/ui/Button';

export interface StorePaymentConfig {
  id?: string;
  provider: string;
  isEnabled: boolean;
  testMode: boolean;
  displayName?: string | null;
  displayNameAr?: string | null;
  fixedFee?: number;
  /** Non-secret per-provider settings (InstaPay handle/phone/expiry, COD percentage). */
  settings?: Record<string, unknown> | null;
}

/** The manual methods this card renders. Gateways use GatewayConnectCard (schema-driven). */
export type ProviderKind = 'cod' | 'instapay';

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
  onUpdateField: (
    field: keyof StorePaymentConfig,
    value: string | number | boolean | null | Record<string, unknown>
  ) => void;
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
  const isAr = useLocale() === 'ar';

  return (
    <div
      className={`rounded-xl border bg-card shadow-sm overflow-hidden transition-all ${
        form.isEnabled ? 'border-s-4' : ''
      }`}
      style={form.isEnabled ? { borderInlineStartColor: provider.color } : undefined}
    >
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <ProviderLogo code={provider.id} name={isAr ? provider.nameAr : provider.name} />
          <div>
            {/* The provider name leads in the admin's own language; the other is the secondary line (audit S-6). */}
            <h3 className="font-semibold text-foreground">
              {isAr ? provider.nameAr : provider.name}
            </h3>
            <p className="text-xs text-muted-foreground" lang={isAr ? 'en' : 'ar'}>
              {isAr ? provider.name : provider.nameAr}
            </p>
          </div>
        </div>

        {
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

            <Button variant="outline" size="sm" type="button" onClick={onToggleExpanded}>
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
            </Button>
          </div>
        }
      </div>

      {expanded && (
        <div className="border-t bg-muted p-6 space-y-5">
          {provider.kind === 'cod' ? (
            <CodFields form={form} onUpdateField={onUpdateField} />
          ) : (
            <InstapayFields form={form} onUpdateField={onUpdateField} />
          )}

          {message && (
            <Alert
              compact
              variant={message.type === 'success' ? 'success' : 'destructive'}
              description={message.text}
            />
          )}

          <div className="flex justify-end">
            <Button variant="default" size="md" type="button" onClick={onSave} disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
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
  onUpdateField: (
    field: keyof StorePaymentConfig,
    value: string | number | boolean | null | Record<string, unknown>
  ) => void;
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
            className="w-full rounded-lg border border-input px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
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
            className="w-full rounded-lg border border-input px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="sm:col-span-2">
          <label
            data-setting-id="payment.cod-fee"
            className="block text-sm font-medium text-foreground mb-1"
          >
            {t('fixedFeeLabel')}
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={0}
              step={0.01}
              value={minorToDecimalString(Number(form.fixedFee) || 0)}
              onChange={e =>
                onUpdateField(
                  'fixedFee',
                  Math.max(0, roundToMinor(parseFloat(e.target.value) || 0))
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

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          {t('percentLabel')}
        </label>
        <input
          type="number"
          min={0}
          max={50}
          step={0.01}
          value={settingNumber(form, 'percentBps') / 100}
          onChange={e =>
            onUpdateField(
              'settings',
              mergeSettings(form, {
                percentBps: Math.min(
                  5000,
                  Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100))
                ),
              })
            )
          }
          className="w-40 rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('percentHelp')}</p>
      </div>

      <div className="rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
        {t('infoBanner')}
      </div>
    </>
  );
}

const settingString = (form: StorePaymentConfig, key: string): string => {
  const v = form.settings?.[key];
  return typeof v === 'string' ? v : '';
};
const settingNumber = (form: StorePaymentConfig, key: string): number => {
  const v = form.settings?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};
const mergeSettings = (form: StorePaymentConfig, patch: Record<string, unknown>) => ({
  ...(form.settings ?? {}),
  ...patch,
});

function InstapayFields({
  form,
  onUpdateField,
}: {
  form: StorePaymentConfig;
  onUpdateField: (
    field: keyof StorePaymentConfig,
    value: string | number | boolean | null | Record<string, unknown>
  ) => void;
}) {
  const t = useT('paymentSettings.instapay');
  const setSetting = (key: string, value: string | number) =>
    onUpdateField('settings', mergeSettings(form, { [key]: value }) as never);
  const input =
    'w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            data-setting-id="payment.instapay-handle"
            className="block text-sm font-medium text-foreground mb-1"
          >
            {t('handleLabel')}
          </label>
          <input
            type="text"
            dir="ltr"
            value={settingString(form, 'handle')}
            onChange={e => setSetting('handle', e.target.value)}
            placeholder={t('handlePlaceholder')}
            className={input}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('phoneLabel')}
          </label>
          <input
            type="tel"
            dir="ltr"
            value={settingString(form, 'phone')}
            onChange={e => setSetting('phone', e.target.value)}
            placeholder={t('phonePlaceholder')}
            className={input}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('accountNameLabel')}
          </label>
          <input
            type="text"
            value={settingString(form, 'accountName')}
            onChange={e => setSetting('accountName', e.target.value)}
            className={input}
          />
        </div>
        <div>
          <label
            data-setting-id="payment.instapay-expiry"
            className="block text-sm font-medium text-foreground mb-1"
          >
            {t('expiryLabel')}
          </label>
          <input
            type="number"
            min={1}
            max={336}
            value={settingNumber(form, 'expiryHours') || INSTAPAY_DEFAULT_EXPIRY_HOURS}
            onChange={e =>
              setSetting(
                'expiryHours',
                Math.min(
                  336,
                  Math.max(1, Math.floor(Number(e.target.value) || INSTAPAY_DEFAULT_EXPIRY_HOURS))
                )
              )
            }
            className="w-32 rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('expiryHelp')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('noteEnLabel')}
          </label>
          <input
            type="text"
            value={settingString(form, 'noteEn')}
            onChange={e => setSetting('noteEn', e.target.value)}
            maxLength={300}
            className={input}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('noteArLabel')}
          </label>
          <input
            type="text"
            lang="ar"
            dir="rtl"
            value={settingString(form, 'noteAr')}
            onChange={e => setSetting('noteAr', e.target.value)}
            maxLength={300}
            className={input}
          />
        </div>
      </div>
      <div className="rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
        {t('infoBanner')}
      </div>
    </>
  );
}
