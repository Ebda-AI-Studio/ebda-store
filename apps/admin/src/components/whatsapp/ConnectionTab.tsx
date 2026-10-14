'use client';

/**
 * ConnectionTab — extracted from /stores/[id]/integrations/wbs/page.tsx.
 * Handles connecting/disconnecting the WBS API key and configuring templates.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button, useToast } from '@ebda/ui';
import { apiGet, apiPut } from '../../lib/api';
import { useT } from '../../i18n/useT';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AvailableTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  variableCount: number;
}

interface ConnectedTenant {
  businessName: string;
  phoneNumber: string | null;
  availableTemplates: AvailableTemplate[];
}

interface TemplateEntry {
  name: string;
  languageCode: string;
}

interface WbsTemplates {
  orderPaid?: TemplateEntry;
  orderShipped?: TemplateEntry;
  orderDelivered?: TemplateEntry;
}

interface WbsConfig {
  wbsEnabled: boolean;
  wbsClientId: string | null;
  wbsApiKeyMasked: string;
  hasApiKey: boolean;
  wbsTemplates: WbsTemplates | null;
  connectedTenant: ConnectedTenant | null;
  connectedTenantError?: string | null;
  /**
   * True ONLY when the live fetchMetadata() call to WBS succeeded on this
   * request. connectedTenant may be non-null even when this is false (the API
   * augments it from local approved templates so this tab can show the template
   * list). Use wbsLiveVerified — not connectedTenant != null — to drive the
   * green "Connected" banner state.
   */
  wbsLiveVerified?: boolean;
  /** Whether the WA customer-DM ordering state machine is active for this store. Default false. */
  waCustomerOrderingEnabled: boolean;
}

const DEFAULT_CONFIG: WbsConfig = {
  wbsEnabled: false,
  wbsClientId: null,
  wbsApiKeyMasked: '',
  hasApiKey: false,
  wbsTemplates: null,
  connectedTenant: null,
  waCustomerOrderingEnabled: false,
};

// Template-picker helpers (templateLabel / templateValue /
// parseTemplateValue / selectTemplate) were removed when the duplicate
// "Message Templates" picker in this tab was deleted. Per-event
// template selection now lives exclusively in the Order Updates tab.

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectionTab({ storeId }: { storeId: string }) {
  const { success: toastSuccess, error: toastError } = useToast();
  const t = useT('whatsappIntegration.connection');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<WbsConfig>(DEFAULT_CONFIG);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [enableToggle, setEnableToggle] = useState(false);
  const [waOrderingEnabled, setWaOrderingEnabled] = useState(false);
  const [savingWaOrdering, setSavingWaOrdering] = useState(false);

  const fetchConfig = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    // apiRequest auto-unwraps the API's `data` envelope — the value
    // it returns IS the WbsConfig payload. Don't double-unwrap with
    // `data.data` (the bug this tab carried since the extraction
    // from the old /integrations/wbs page — caused config to never
    // populate, so isConnected was permanently false and the Connect
    // form rendered even after a successful save).
    const { data: cfg } = await apiGet<WbsConfig>(`/api/v1/stores/${storeId}/integrations/wbs`);
    if (cfg) {
      setConfig(cfg);
      setEnableToggle(cfg.wbsEnabled);
      setWaOrderingEnabled(cfg.waCustomerOrderingEnabled ?? false);
    }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleConnect = async () => {
    if (!apiKeyInput.trim()) return;
    setConnecting(true);
    try {
      const { data, error } = await apiPut<{
        templatesAutoSeeded?: number;
        templatesAutoSubmitted?: number;
        templatesAutoError?: string;
      }>(`/api/v1/stores/${storeId}/integrations/wbs`, {
        wbsApiKey: apiKeyInput.trim(),
      });
      if (error) {
        if (error.code === 'INVALID_API_KEY' || error.message?.includes('invalid_api_key')) {
          toastError(t('toastInvalidKeyTitle'), t('toastInvalidKeyBody'));
        } else {
          toastError(t('toastConnectFailedTitle'), error.message || t('toastConnectFailedBody'));
        }
      } else {
        const seeded = data?.templatesAutoSeeded;
        const submitted = data?.templatesAutoSubmitted;
        const autoErr = data?.templatesAutoError;
        if (autoErr) {
          toastSuccess(t('toastConnectedTitle'), t('toastConnectedAutoErr', { error: autoErr }));
        } else if (seeded && seeded > 0) {
          toastSuccess(
            t('toastConnectedSeededTitle'),
            t('toastConnectedSeededBody', { seeded, submitted: submitted ?? 0 })
          );
        } else {
          toastSuccess(t('toastConnectedTitle'), t('toastConnectedBody'));
        }
        setApiKeyInput('');
        await fetchConfig();
      }
    } catch {
      toastError(t('toastConnectFailedTitle'), t('toastUnexpected'));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        wbsApiKey: null,
      });
      if (error) {
        toastError(
          t('toastDisconnectFailedTitle'),
          error.message || t('toastDisconnectFailedBody')
        );
      } else {
        toastSuccess(t('toastDisconnectedTitle'), t('toastDisconnectedBody'));
        await fetchConfig();
      }
    } catch {
      toastError(t('toastDisconnectFailedTitle'), t('toastUnexpected'));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTemplates = async () => {
    setSaving(true);
    try {
      // ONLY send wbsEnabled from this tab. wbsTemplates is owned by
      // the Order Updates tab — including it here would wipe the
      // per-event picks (which load into local state empty until the
      // user touches them) every time the merchant clicks Save in
      // Connection. Order Updates tab handles wbsTemplates writes
      // entirely.
      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        wbsEnabled: enableToggle,
      });
      if (error) {
        if (error.code === 'MUST_CONNECT_KEY_FIRST') {
          toastError(t('toastConnectFirstTitle'), t('toastConnectFirstBody'));
        } else {
          toastError(t('toastSaveFailedTitle'), error.message || t('toastSaveFailedBody'));
        }
      } else {
        toastSuccess(t('toastSavedTitle'), t('toastSavedBody'));
        await fetchConfig();
      }
    } catch {
      toastError(t('toastSaveFailedTitle'), t('toastUnexpected'));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWaOrdering = async (newValue: boolean) => {
    setSavingWaOrdering(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        waCustomerOrderingEnabled: newValue,
      });
      if (error) {
        toastError(t('toastSaveFailedTitle'), error.message || t('toastWaSaveFailedBody'));
        // Revert optimistic update
        setWaOrderingEnabled(!newValue);
      } else {
        toastSuccess(
          newValue ? t('toastWaOnTitle') : t('toastWaOffTitle'),
          newValue ? t('toastWaOnBody') : t('toastWaOffBody')
        );
        await fetchConfig();
      }
    } catch {
      toastError(t('toastSaveFailedTitle'), t('toastUnexpected'));
      setWaOrderingEnabled(!newValue);
    } finally {
      setSavingWaOrdering(false);
    }
  };

  // Derived state: treat hasApiKey+wbsEnabled as connected, even if live check failed.
  // tenantDetailsAvailable uses wbsLiveVerified (not connectedTenant != null) so the
  // green "Connected to businessName" banner is shown only when the live WBS call
  // actually succeeded — not when connectedTenant is populated from local templates only.
  const isConnected = config.hasApiKey && config.wbsEnabled;
  const tenantDetailsAvailable = isConnected && Boolean(config.wbsLiveVerified);
  const tenantDetailsFailed = isConnected && !config.wbsLiveVerified;
  const keySetNotEnabled = config.hasApiKey && !config.wbsEnabled;
  const templates = config.connectedTenant?.availableTemplates || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Connect form — only when no key yet */}
      {!isConnected && !keySetNotEnabled && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
          <div>
            <h3 className="font-medium text-foreground">{t('connectTitle')}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t('connectDescription')}</p>
          </div>
          <div className="space-y-1">
            <label htmlFor="wbsApiKey" className="text-sm font-medium text-foreground">
              {t('apiKeyLabel')}
            </label>
            <input
              id="wbsApiKey"
              type="password"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              placeholder={t('apiKeyPlaceholder')}
              autoComplete="new-password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-muted-foreground">{t('apiKeyHint')}</p>
          </div>
          <Button onClick={handleConnect} disabled={connecting || !apiKeyInput.trim()}>
            {connecting ? t('connecting') : t('connect')}
          </Button>
        </div>
      )}

      {/* Key set but wbsEnabled=false */}
      {keySetNotEnabled && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
          <div>
            <h3 className="font-medium text-foreground">{t('finishTitle')}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t('finishDescription')}</p>
          </div>
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="text-red-600 border-red-300"
              onClick={handleDisconnect}
              disabled={saving}
            >
              {saving ? t('disconnecting') : t('removeKey')}
            </Button>
          </div>
        </div>
      )}

      {/* Connected banner */}
      {isConnected && (
        <>
          <div
            className={`rounded-xl border p-4 flex items-start justify-between gap-4 ${
              tenantDetailsAvailable
                ? 'border-green-200 bg-green-50 dark:border-green-900/50 dark:bg-green-950/30'
                : 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30'
            }`}
          >
            <div>
              {tenantDetailsAvailable && config.connectedTenant ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-green-700 dark:text-green-400 font-medium">
                      {t('connectedTo', { name: config.connectedTenant.businessName })}
                    </span>
                    {config.connectedTenant.phoneNumber && (
                      <span className="text-sm text-green-600 dark:text-green-500">
                        ({config.connectedTenant.phoneNumber})
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">
                    {templates.length !== 1
                      ? t('templateCountPlural', { count: templates.length })
                      : t('templateCount', { count: templates.length })}{' '}
                    {t('available')}
                  </p>
                </>
              ) : (
                <div>
                  <span className="text-amber-700 dark:text-amber-400 font-medium">
                    {t('savedNotVerified')}
                  </span>
                  {tenantDetailsFailed && (
                    <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                      {config.connectedTenantError === 'invalid_api_key'
                        ? t('keyInvalid')
                        : t('cantVerify')}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 flex-shrink-0">
              {tenantDetailsFailed && (
                <Button size="sm" variant="outline" onClick={fetchConfig} disabled={loading}>
                  {t('retry')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="text-red-600 border-red-300"
                onClick={handleDisconnect}
                disabled={saving}
              >
                {saving ? t('disconnecting') : t('disconnect')}
              </Button>
            </div>
          </div>

          {/* Per-event template picking lives in the Order Updates tab —
              removed from here to eliminate the duplicate UI Ahmad
              flagged. Template-name → lifecycle event mapping
              (orderPaid / orderShipped / orderDelivered + per-event
              channel toggles + Meta status) is all there now. */}

          {/* Enable toggle */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-foreground">{t('notificationsTitle')}</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('notificationsDescription')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enableToggle}
                onClick={() => setEnableToggle(prev => !prev)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  enableToggle ? 'bg-primary' : 'bg-muted'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enableToggle ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Save */}
          <div className="flex justify-end">
            <Button onClick={handleSaveTemplates} disabled={saving}>
              {saving ? t('saving') : t('saveSettings')}
            </Button>
          </div>

          {/* Customer ordering via WhatsApp DM */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h3 className="font-medium text-foreground">{t('waOrderingTitle')}</h3>
                <p className="text-sm text-muted-foreground mt-1">{t('waOrderingDescription')}</p>
                <p className="text-xs text-muted-foreground mt-1.5 italic">{t('waOrderingNote')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={waOrderingEnabled}
                disabled={savingWaOrdering}
                onClick={() => {
                  const newValue = !waOrderingEnabled;
                  setWaOrderingEnabled(newValue);
                  handleSaveWaOrdering(newValue);
                }}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed ${
                  waOrderingEnabled ? 'bg-primary' : 'bg-muted'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    waOrderingEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
