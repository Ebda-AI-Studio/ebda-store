'use client';

import { buttonVariants } from '@/components/ui/Button';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import {
  isMaskedSecret,
  validateCredentialValue,
  type CredentialFieldDef,
  type ConnectionCheckView,
  type CredentialMode,
  type ProviderCatalogEntry,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Alert } from '../../../../../components/Alert';
import { apiPost, apiPut } from '../../../../../lib/api';
import { UnverifiedProviderNotice } from '../../../../../components/UnverifiedProviderNotice';
import { PickupAddressForm, type PickupAddress } from './PickupAddressForm';
import {
  pickupFromSettings,
  pickupToSettings,
  type CarrierConfigRow,
  type CarrierSettings,
} from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface TestOutcome {
  ok: boolean;
  code: string;
  message?: string;
  latency?: number;
}

interface Notice {
  type: 'success' | 'error';
  text: string;
}

interface Props {
  entry: ProviderCatalogEntry;
  config: CarrierConfigRow | undefined;
  storeId: string;
  /** Refetch the store's configs after any write. */
  onChanged: () => Promise<void> | void;
}

const inputClass = FIELD_CLASSES;
const btnPrimary = buttonVariants({ size: 'sm' });
const btnOutline = buttonVariants({ variant: 'outline', size: 'sm' });

const MODES: readonly CredentialMode[] = ['sandbox', 'live'];
const TEST_CODES = ['ok', 'bad_credentials', 'wrong_mode', 'incomplete', 'unreachable', 'unknown'];
const VALIDATION_REASONS: Record<string, string> = {
  required: 'required',
  'contains control characters': 'controlChars',
  'too long': 'tooLong',
  'must be a whole number': 'wholeNumber',
  'has the wrong format': 'wrongFormat',
};
const BOSTA_SIZES = ['SMALL', 'MEDIUM', 'LARGE'];
const SHIPBLU_SIZES = ['1', '2', '3', '4'];

/**
 * One schema-driven connect card for a shipping carrier of the provider catalog (Bosta, ShipBlu,
 * Mylerz, Aramex): credential fields per mode (write-only secrets), Test connection, the enable
 * gate, and the carrier's non-secret settings (pickup address, weight, size, Aramex product).
 */
export function CarrierConnectCard({ entry, config, storeId, onChanged }: Props) {
  const t = useT('shipping.carriers.connect');
  const locale: 'ar' | 'en' = useLocale() === 'ar' ? 'ar' : 'en';
  const base = `/api/v1/stores/${storeId}/shipping-carriers`;
  const configUrl = `${base}/configs/${entry.code}`;

  const activeMode: CredentialMode =
    config?.mode ?? (config?.testMode === false ? 'live' : 'sandbox');
  const [mode, setMode] = useState<CredentialMode>(activeMode);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const [open, setOpen] = useState(false);

  const hints = config?.credentialHints ?? null;
  const hintsKey = JSON.stringify(hints?.[mode] ?? {});

  // Non-secrets are prefilled with what is saved; secrets stay empty (write-only).
  useEffect(() => {
    const saved = hints?.[mode] ?? {};
    const next: Record<string, string> = {};
    for (const f of entry.fields) {
      const h = saved[f.key];
      next[f.key] = !f.secret && h && typeof h.value === 'string' ? h.value : '';
    }
    setValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintsKey, mode, entry.code]);

  const hintFor = useCallback(
    (m: CredentialMode, key: string) => hints?.[m]?.[key] ?? null,
    [hints]
  );
  const requiredSavedFor = (m: CredentialMode) =>
    entry.fields.every(f => !f.required || hintFor(m, f.key) !== null);
  const activeReady = Boolean(config) && requiredSavedFor(activeMode);

  // PROVIDERS-3: an unverified provider connects like any other; the automatic check on save
  // (and Test connection) is the gate, and the first real order confirms it.
  const unverified = !entry.manual && !entry.verified;
  const connected = Boolean(config?.connectionTestCurrent && config?.connectionTest?.ok);
  const canEnable = connected;
  const enableBlockedReason = !config
    ? t('enable.saveFirst')
    : !connected
      ? t('enable.testFirst')
      : null;

  const statusKey = config?.enabled ? 'enabled' : connected ? 'connected' : 'notConnected';
  const statusTone =
    statusKey === 'enabled'
      ? 'bg-success/10 text-success-ink'
      : statusKey === 'connected'
        ? 'bg-info/10 text-info-ink'
        : 'bg-muted text-muted-foreground';

  function localizedReason(field: CredentialFieldDef, reason: string): string {
    const k = VALIDATION_REASONS[reason];
    return `${field.label[locale]}: ${t(`validation.${k ?? 'generic'}`)}`;
  }

  /** Only what the user typed; '' keeps the saved value, a masked echo is never sent. */
  function collectTyped(): { fields: Record<string, string>; error: string | null } {
    const fields: Record<string, string> = {};
    for (const f of entry.fields) {
      const raw = (values[f.key] ?? '').trim();
      if (raw === '') continue;
      if (isMaskedSecret(raw)) continue;
      const saved = hintFor(mode, f.key);
      if (!f.secret && saved && saved.value === raw) continue;
      const reason = validateCredentialValue(f, raw);
      if (reason) return { fields: {}, error: localizedReason(f, reason) };
      fields[f.key] = raw;
    }
    return { fields, error: null };
  }

  async function saveCredentials(activate: boolean) {
    const { fields, error } = collectTyped();
    if (error) {
      setNotice({ type: 'error', text: error });
      return;
    }
    if (!activate && Object.keys(fields).length === 0) {
      setNotice({ type: 'error', text: t('messages.nothingToSave') });
      return;
    }
    setBusy(activate ? 'activate' : 'save');
    setNotice(null);
    const { data, error: apiErr } = await apiPut<{
      disabledUntilRetested?: boolean;
      check?: ConnectionCheckView | null;
    }>(configUrl, {
      mode,
      credentials: fields,
      ...(activate ? { activate: true } : {}),
    });
    setBusy(null);
    if (apiErr) {
      setNotice({ type: 'error', text: apiErr.message || t('messages.failed') });
      return;
    }
    setTest(null);
    const savedText = data?.disabledUntilRetested
      ? t('messages.savedDisabled')
      : activate
        ? t('messages.modeActivated', { mode: t(`modes.${mode}`) })
        : t('messages.saved');
    // PROVIDERS-3: the automatic check ran on save; say connected / wrong credentials / unreachable.
    const check = data?.check;
    setNotice({
      type: check && !check.ok ? 'error' : 'success',
      text: check
        ? `${savedText} ${locale === 'ar' ? check.messageAr : check.messageEn}`
        : savedText,
    });
    await onChanged();
  }

  async function runTest() {
    setBusy('test');
    setNotice(null);
    setTest(null);
    const { data, error: apiErr } = await apiPost<{ test: TestOutcome }>(
      `${base}/test/${entry.code}`
    );
    setBusy(null);
    if (apiErr || !data?.test) {
      setNotice({ type: 'error', text: apiErr?.message || t('messages.failed') });
      return;
    }
    setTest(data.test);
    await onChanged();
  }

  async function toggle(enabled: boolean) {
    setBusy('toggle');
    setNotice(null);
    const { error: apiErr } = await apiPut(configUrl, { enabled });
    setBusy(null);
    if (apiErr) {
      const text =
        apiErr.code === 'CONNECTION_NOT_TESTED'
          ? t('enable.testFirst')
          : apiErr.message || t('messages.failed');
      setNotice({ type: 'error', text });
      return;
    }
    await onChanged();
  }

  async function makeDefault() {
    setBusy('default');
    setNotice(null);
    const { error: apiErr } = await apiPost(`${base}/default/${entry.code}`);
    setBusy(null);
    if (apiErr) {
      setNotice({ type: 'error', text: apiErr.message || t('messages.failed') });
      return;
    }
    setNotice({ type: 'success', text: t('messages.defaultSet') });
    await onChanged();
  }

  async function rotateSecret() {
    setBusy('rotate');
    setNotice(null);
    const { error: apiErr } = await apiPost(`${base}/webhook-secret/${entry.code}/rotate`);
    setBusy(null);
    setNotice(
      apiErr
        ? { type: 'error', text: t('messages.rotateFailed') }
        : { type: 'success', text: t('messages.secretRotated') }
    );
  }

  const testCode = test ? (TEST_CODES.includes(test.code) ? test.code : 'unknown') : null;
  const sizes =
    entry.code === 'shipblu' ? SHIPBLU_SIZES : entry.code === 'bosta' ? BOSTA_SIZES : [];

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-card shadow-sm ${
        config?.enabled ? 'border-s-4' : ''
      }`}
      style={config?.enabled ? { borderInlineStartColor: entry.logo.color } : undefined}
      data-testid={`carrier-card-${entry.code}`}
    >
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
          style={{ backgroundColor: entry.logo.color }}
          aria-hidden="true"
        >
          {entry.logo.monogram}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-foreground">{entry.name[locale]}</h3>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone}`}>
              {t(`status.${statusKey}`)}
            </span>
            {config?.isDefault && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-ink">
                {t('default.badge')}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.capabilities.methods.map(m => (
              <span
                key={m}
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {t(`capabilities.${m}`)}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className={btnOutline}
        >
          {t('configure')}
        </button>
      </div>

      {unverified && (
        <div className="border-t px-4 py-3">
          <UnverifiedProviderNotice />
        </div>
      )}

      {open && (
        <div className="space-y-4 border-t bg-muted p-4">
          {/* mode switch */}
          <div>
            <div role="tablist" aria-label={t('modes.label')} className="flex gap-2">
              {MODES.map(m => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => {
                    setMode(m);
                    setNotice(null);
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${
                    mode === m
                      ? 'border-primary bg-primary/10 font-medium text-foreground'
                      : 'border-border text-muted-foreground hover:bg-background'
                  }`}
                >
                  {t(`modes.${m}`)}
                  {activeMode === m && config && (
                    <span className="ms-2 rounded-full bg-success/10 px-1.5 py-0.5 text-xs text-success-ink">
                      {t('modes.active')}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {mode !== activeMode && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{t('modes.notActive', { mode: t(`modes.${activeMode}`) })}</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => saveCredentials(true)}
                  className={btnOutline}
                >
                  {busy === 'activate' ? t('actions.saving') : t('modes.useThis')}
                </button>
              </div>
            )}
          </div>

          {/* fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            {entry.fields.map(f => {
              const hint = hintFor(mode, f.key);
              const id = `${entry.code}-${mode}-${f.key}`;
              const placeholder = f.secret
                ? hint
                  ? hint.last4
                    ? t('secretSavedLast4', { last4: hint.last4 })
                    : t('secretSaved')
                  : t('secretPlaceholder')
                : '';
              return (
                <div key={f.key}>
                  <label htmlFor={id} className="mb-1 block text-sm font-medium text-foreground">
                    {f.label[locale]}
                    {f.required && <span className="text-destructive-ink"> *</span>}
                  </label>
                  <input
                    id={id}
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    dir="ltr"
                    inputMode={f.type === 'integer' ? 'numeric' : undefined}
                    maxLength={f.maxLength}
                    value={values[f.key] ?? ''}
                    placeholder={placeholder}
                    onChange={e => {
                      setValues(prev => ({ ...prev, [f.key]: e.target.value }));
                      setNotice(null);
                    }}
                    aria-describedby={`${id}-help`}
                    className={inputClass}
                  />
                  <p id={`${id}-help`} className="mt-1 text-xs text-muted-foreground">
                    {f.help[locale]}
                  </p>
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-primary">{t('whereToFind')}</summary>
                    <p className="mt-1 text-muted-foreground">{f.whereToFind[locale]}</p>
                  </details>
                </div>
              );
            })}
          </div>

          {(entry.docs.credentials || entry.docs.dashboard) && (
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {entry.docs.credentials && (
                <a
                  href={entry.docs.credentials}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  {t('docsCredentials')}
                </a>
              )}
              {entry.docs.dashboard && (
                <a
                  href={entry.docs.dashboard}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  {t('docsDashboard')}
                </a>
              )}
            </p>
          )}

          {/* save + test */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => saveCredentials(false)}
              disabled={busy !== null}
              className={btnPrimary}
            >
              {busy === 'save' ? t('actions.saving') : t('actions.save')}
            </button>
            <button
              type="button"
              onClick={runTest}
              disabled={busy !== null || !activeReady}
              className={btnOutline}
            >
              {busy === 'test'
                ? t('actions.testing')
                : t('actions.test', { mode: t(`modes.${activeMode}`) })}
            </button>
          </div>
          {!activeReady && (
            <p className="text-xs text-muted-foreground">
              {t('testDisabled', { mode: t(`modes.${activeMode}`) })}
            </p>
          )}

          {notice && (
            <Alert
              compact
              variant={notice.type === 'success' ? 'success' : 'destructive'}
              description={notice.text}
            />
          )}

          {test && testCode && (
            <Alert
              compact
              variant={test.ok ? 'success' : 'destructive'}
              description={
                <p>
                  {t(`test.${testCode}`)}
                  {typeof test.latency === 'number' && (
                    <span className="ms-2 text-xs opacity-70">
                      {t('test.latency', { ms: test.latency })}
                    </span>
                  )}
                </p>
              }
            />
          )}

          {/* tracking webhook */}
          {entry.webhook && (
            <div className="rounded-lg border border-border bg-background p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <p className="font-medium text-foreground">{t('webhook.label')}</p>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {entry.webhook.delivery === 'per-request'
                    ? t('webhook.automatic')
                    : t('webhook.pasteIt')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{entry.webhook.setupHelp[locale]}</p>
              {entry.code === 'bosta' && (
                <button
                  type="button"
                  onClick={rotateSecret}
                  disabled={busy !== null || !config}
                  className={`${btnOutline} mt-2`}
                >
                  {t('rotateSecret')}
                </button>
              )}
            </div>
          )}

          <CarrierSettingsForm
            entry={entry}
            config={config}
            sizes={sizes}
            configUrl={configUrl}
            busy={busy !== null}
            onChanged={onChanged}
          />

          {/* enable + default */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t('enable.label')}</p>
              {!config?.enabled && enableBlockedReason && (
                <p className="text-xs text-muted-foreground">{enableBlockedReason}</p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {config?.enabled && !config.isDefault && (
                <button
                  type="button"
                  onClick={makeDefault}
                  disabled={busy !== null}
                  className={btnOutline}
                >
                  {t('default.set')}
                </button>
              )}
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t('enable.label')}
                  checked={Boolean(config?.enabled)}
                  disabled={busy !== null || (!config?.enabled && !canEnable)}
                  onChange={e => toggle(e.target.checked)}
                  className="peer sr-only"
                />
                <div className="peer h-6 w-11 rounded-full bg-border after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-500 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400/40 peer-disabled:opacity-50" />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The carrier's non-secret settings, saved with PUT `settings`. The saved settings object is the
 * base, so keys this form does not own are never dropped. The mode (sandbox/live) is the row's
 * own field and is never a setting.
 */
function CarrierSettingsForm({
  entry,
  config,
  sizes,
  configUrl,
  busy,
  onChanged,
}: {
  entry: ProviderCatalogEntry;
  config: CarrierConfigRow | undefined;
  sizes: string[];
  configUrl: string;
  busy: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useT('shipping.carriers.connect');
  const saved: CarrierSettings = config?.settings ?? {};
  const savedKey = JSON.stringify(saved);

  const [pickup, setPickup] = useState<PickupAddress>(pickupFromSettings(saved));
  const [weight, setWeight] = useState(
    saved.defaultWeight != null ? String(saved.defaultWeight) : ''
  );
  const [size, setSize] = useState(saved.packageSize != null ? String(saved.packageSize) : '');
  const [productType, setProductType] = useState(String(saved.productType ?? ''));
  const [codEgp, setCodEgp] = useState(saved.codEgpConfirmed === true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    setPickup(pickupFromSettings(saved));
    setWeight(saved.defaultWeight != null ? String(saved.defaultWeight) : '');
    setSize(saved.packageSize != null ? String(saved.packageSize) : '');
    setProductType(String(saved.productType ?? ''));
    setCodEgp(saved.codEgpConfirmed === true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, entry.code]);

  const isAramex = entry.code === 'aramex';

  async function save() {
    const w = weight.trim();
    const weightNum = w === '' ? null : Number(w);
    if (weightNum !== null && (!Number.isFinite(weightNum) || weightNum <= 0)) {
      setNotice({ type: 'error', text: t('settings.defaultWeightInvalid') });
      return;
    }
    const next: CarrierSettings = { ...saved, ...pickupToSettings(pickup) };
    // `sandbox` is the row's mode, not a setting.
    delete next.sandbox;
    if (weightNum === null) delete next.defaultWeight;
    else next.defaultWeight = weightNum;
    if (sizes.length > 0) {
      if (size === '') delete next.packageSize;
      else next.packageSize = entry.code === 'shipblu' ? Number(size) : size;
    }
    if (isAramex) {
      const pt = productType.trim();
      if (pt === '') delete next.productType;
      else next.productType = pt;
      next.codEgpConfirmed = codEgp;
    }
    setSaving(true);
    setNotice(null);
    const { error } = await apiPut(configUrl, { settings: next });
    setSaving(false);
    if (error) {
      setNotice({ type: 'error', text: error.message || t('messages.failed') });
      return;
    }
    setNotice({ type: 'success', text: t('messages.settingsSaved') });
    await onChanged();
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <p className="text-sm font-medium text-foreground">{t('settings.title')}</p>
      <PickupAddressForm
        value={pickup}
        onChange={patch => {
          setPickup(p => ({ ...p, ...patch }));
          setNotice(null);
        }}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor={`${entry.code}-weight`}
            className="mb-1 block text-xs text-muted-foreground"
          >
            {t('settings.defaultWeight')}
          </label>
          <input
            id={`${entry.code}-weight`}
            type="text"
            inputMode="decimal"
            dir="ltr"
            value={weight}
            onChange={e => setWeight(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.defaultWeightHelp')}</p>
        </div>
        {sizes.length > 0 && (
          <div>
            <label
              htmlFor={`${entry.code}-size`}
              className="mb-1 block text-xs text-muted-foreground"
            >
              {t('settings.packageSize')}
            </label>
            <select
              id={`${entry.code}-size`}
              value={size}
              onChange={e => setSize(e.target.value)}
              className={inputClass}
            >
              <option value="" />
              {sizes.map(s => (
                <option key={s} value={s}>
                  {t(`settings.sizes.${s}`)}
                </option>
              ))}
            </select>
          </div>
        )}
        {isAramex && (
          <div>
            <label
              htmlFor="aramex-product-type"
              className="mb-1 block text-xs text-muted-foreground"
            >
              {t('settings.productType')}
            </label>
            <input
              id="aramex-product-type"
              type="text"
              dir="ltr"
              maxLength={40}
              value={productType}
              onChange={e => setProductType(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.productTypeHelp')}</p>
          </div>
        )}
      </div>
      {isAramex && (
        <div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={codEgp}
              onChange={e => setCodEgp(e.target.checked)}
              className="mt-0.5"
            />
            {t('settings.codEgpConfirmed')}
          </label>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.codNotice')}</p>
        </div>
      )}
      <button type="button" onClick={save} disabled={busy || saving} className={btnOutline}>
        {saving ? t('actions.saving') : t('settings.save')}
      </button>
      {notice && (
        <Alert
          compact
          variant={notice.type === 'success' ? 'success' : 'destructive'}
          description={notice.text}
        />
      )}
    </div>
  );
}
