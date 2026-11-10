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

/** One saved-credential hint: secrets only say they are set (+ last 4), non-secrets echo the value. */
type CredentialHint = { set: true; last4?: string; value?: string };
type CredentialHints = Partial<Record<CredentialMode, Record<string, CredentialHint>>>;

export interface GatewayConfig {
  id?: string;
  provider: string;
  isEnabled: boolean;
  /** true = the sandbox credentials are the active ones. */
  testMode: boolean;
  settings?: Record<string, unknown> | null;
  credentialHints?: CredentialHints | null;
  connectionTest?: { ok: boolean; code: string; mode: CredentialMode; at: string } | null;
  connectionTestCurrent?: boolean;
  webhookUrl?: string | null;
  healthStatus?: 'healthy' | 'degraded' | 'down' | 'unknown' | null;
  circuit?: 'healthy' | 'degraded' | 'down' | null;
}

interface TestOutcome {
  ok: boolean;
  code: string;
  message?: string;
  details?: Record<string, unknown>;
  latency?: number;
}

interface Notice {
  type: 'success' | 'error';
  text: string;
}

interface Props {
  entry: ProviderCatalogEntry;
  config: GatewayConfig | undefined;
  storeId: string;
  /** Refetch the store's configs after any write. */
  onChanged: () => Promise<void> | void;
}

const inputClass =
  'w-full rounded-lg border border-input bg-background px-3 py-1.5 text-base sm:text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
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

const asStringList = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string')
    ? (v as string[])
    : fallback;

export function GatewayConnectCard({ entry, config, storeId, onChanged }: Props) {
  const t = useT('paymentSettings.connect');
  const locale: 'ar' | 'en' = useLocale() === 'ar' ? 'ar' : 'en';
  const base = `/api/v1/payment-settings/store/${storeId}/${entry.code}`;

  const activeMode: CredentialMode = config?.testMode === false ? 'live' : 'sandbox';
  const [mode, setMode] = useState<CredentialMode>(activeMode);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const [copied, setCopied] = useState(false);
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
    : !config.connectionTestCurrent || !config.connectionTest?.ok
      ? t('enable.testFirst')
      : null;

  const statusKey = config?.isEnabled ? 'enabled' : connected ? 'connected' : 'notConnected';
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
    }>(`${base}/credentials`, { mode, fields, ...(activate ? { activate: true } : {}) });
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
    const { data, error: apiErr } = await apiPost<{ test: TestOutcome }>(`${base}/test`);
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
    const { error: apiErr } = await apiPost(`${base}/toggle`, { enabled });
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

  async function copyWebhook(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked: the input is focus-to-select, so it can still be copied by hand
    }
  }

  const testCode = test ? (TEST_CODES.includes(test.code) ? test.code : 'unknown') : null;

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-card shadow-sm ${
        config?.isEnabled ? 'border-s-4' : ''
      }`}
      style={config?.isEnabled ? { borderInlineStartColor: entry.logo.color } : undefined}
      data-testid={`gateway-card-${entry.code}`}
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
            {config?.isEnabled && <HealthChip config={config} />}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.capabilities.methods.map(m => (
              <span
                key={m}
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {t(`methods.${m}`)}
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
          <UnverifiedProviderNotice pending={!entry.capabilities.webhooks} />
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
                  {/* SHARIA-BNPL-1: an installment method is financed by the provider; its terms and fees apply. */}
                  {(f.key === 'integrationId.valu' || f.key === 'integrationId.kiosk') && (
                    <p role="note" className="mt-1 rounded-md bg-muted p-2 text-xs text-foreground">
                      {t('bnplDisclosure')}
                    </p>
                  )}
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
                <div>
                  <p>
                    {t(`test.${testCode}`)}
                    {typeof test.latency === 'number' && (
                      <span className="ms-2 text-xs opacity-70">
                        {t('test.latency', { ms: test.latency })}
                      </span>
                    )}
                  </p>
                  {test.details && Object.keys(test.details).length > 0 && (
                    <dl
                      className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs opacity-80"
                      dir="ltr"
                    >
                      {Object.entries(test.details).map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt>{k}</dt>
                          <dd className="break-all">
                            {typeof v === 'string' ? v : JSON.stringify(v)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              }
            />
          )}

          {/* webhook */}
          {entry.webhook && config?.webhookUrl && (
            <div className="rounded-lg border border-border bg-background p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <p className="font-medium text-foreground">{t('webhook.label')}</p>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {entry.webhook.delivery === 'per-request'
                    ? t('webhook.automatic')
                    : t('webhook.pasteIt')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  dir="ltr"
                  readOnly
                  aria-label={t('webhook.label')}
                  value={config.webhookUrl}
                  onFocus={e => e.currentTarget.select()}
                  className={`${inputClass} flex-1 font-mono text-xs`}
                />
                <button
                  type="button"
                  onClick={() => copyWebhook(config.webhookUrl as string)}
                  className={btnOutline}
                >
                  {copied ? t('webhook.copied') : t('webhook.copy')}
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {entry.webhook.setupHelp[locale]}
              </p>
            </div>
          )}

          {/* mode-independent settings */}
          {config && (entry.code === 'kashier' || entry.code === 'fawry') && (
            <GatewayOptions code={entry.code} config={config} base={base} onChanged={onChanged} />
          )}

          {/* enable */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t('enable.label')}</p>
              {!config?.isEnabled && enableBlockedReason && (
                <p className="text-xs text-muted-foreground">{enableBlockedReason}</p>
              )}
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                role="switch"
                aria-label={t('enable.label')}
                checked={Boolean(config?.isEnabled)}
                disabled={busy !== null || (!config?.isEnabled && !canEnable)}
                onChange={e => toggle(e.target.checked)}
                className="peer sr-only"
              />
              <div className="peer h-6 w-11 rounded-full bg-border after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-500 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400/40 peer-disabled:opacity-50" />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/** Kashier (methods, page language) and Fawry (methods, code lifetime): saved with PUT settings. */
function GatewayOptions({
  code,
  config,
  base,
  onChanged,
}: {
  code: 'kashier' | 'fawry';
  config: GatewayConfig;
  base: string;
  onChanged: () => Promise<void> | void;
}) {
  const t = useT('paymentSettings.connect');
  const isKashier = code === 'kashier';
  const settings = config.settings ?? {};
  const allMethods = isKashier ? ['card', 'wallet', 'bnpl'] : ['payatfawry', 'card'];
  const [methods, setMethods] = useState<string[]>(
    asStringList(settings.methods, isKashier ? ['card', 'wallet'] : ['payatfawry', 'card'])
  );
  const [display, setDisplay] = useState<string>(settings.display === 'en' ? 'en' : 'ar');
  const [expiry, setExpiry] = useState<string>(
    String(typeof settings.expiryHours === 'number' ? settings.expiryHours : 72)
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function save() {
    const hours = Number(expiry);
    if (!isKashier && (!Number.isInteger(hours) || hours < 1 || hours > 720)) {
      setNotice({ type: 'error', text: t('options.expiryInvalid') });
      return;
    }
    setBusy(true);
    setNotice(null);
    const body = isKashier ? { methods, display } : { methods, expiryHours: hours };
    const { error } = await apiPut(base, { settings: body });
    setBusy(false);
    if (error) {
      setNotice({ type: 'error', text: error.message || t('messages.failed') });
      return;
    }
    setNotice({ type: 'success', text: t('messages.saved') });
    await onChanged();
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <p className="text-sm font-medium text-foreground">{t('options.title')}</p>
      <fieldset>
        <legend className="mb-1 text-xs text-muted-foreground">{t('options.methods')}</legend>
        <div className="flex flex-wrap gap-4">
          {allMethods.map(m => (
            <label key={m} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={methods.includes(m)}
                onChange={e => {
                  const next = e.target.checked ? [...methods, m] : methods.filter(x => x !== m);
                  if (next.length > 0) setMethods(next);
                }}
              />
              {t(`methods.${m}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {isKashier && methods.includes('bnpl') && (
        <p role="note" className="rounded-md bg-muted p-2 text-xs text-foreground">
          {t('bnplDisclosure')}
        </p>
      )}
      {isKashier ? (
        <div>
          <label htmlFor="kashier-display" className="mb-1 block text-xs text-muted-foreground">
            {t('options.display')}
          </label>
          <select
            id="kashier-display"
            value={display}
            onChange={e => setDisplay(e.target.value)}
            className={`${inputClass} w-40`}
          >
            <option value="ar">{t('options.displayAr')}</option>
            <option value="en">{t('options.displayEn')}</option>
          </select>
        </div>
      ) : (
        <div>
          <label htmlFor="fawry-expiry" className="mb-1 block text-xs text-muted-foreground">
            {t('options.expiryHours')}
          </label>
          <input
            id="fawry-expiry"
            type="text"
            inputMode="numeric"
            dir="ltr"
            value={expiry}
            onChange={e => setExpiry(e.target.value)}
            className={`${inputClass} w-32`}
          />
        </div>
      )}
      <button type="button" onClick={save} disabled={busy} className={btnOutline}>
        {busy ? t('actions.saving') : t('options.save')}
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

/**
 * Live outage state of an ENABLED gateway: the circuit on this API node when it is open, else the
 * last persisted health (the checkout hides a method whose circuit is open).
 */
function HealthChip({ config }: { config: GatewayConfig }) {
  const t = useT('paymentSettings.health');
  const state =
    config.circuit && config.circuit !== 'healthy'
      ? config.circuit
      : (config.healthStatus ?? 'unknown');
  const tone =
    state === 'down'
      ? 'bg-destructive/10 text-destructive-ink'
      : state === 'degraded'
        ? 'bg-warning/10 text-warning-ink'
        : state === 'healthy'
          ? 'bg-success/10 text-success-ink'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
      data-testid="provider-health"
      title={t('note')}
    >
      {t(state)}
    </span>
  );
}
