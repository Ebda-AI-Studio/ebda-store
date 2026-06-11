'use client';

/**
 * ConnectionTab — extracted from /stores/[id]/integrations/wbs/page.tsx.
 * Handles connecting/disconnecting the WBS API key and configuring templates.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button, useToast } from '@force/ui';
import { apiGet, apiPut } from '../../lib/api';

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
          toastError('Invalid key', 'The API key was rejected. Generate a new key in WBS admin.');
        } else {
          toastError('Connection failed', error.message || 'Could not connect to Force AI WhatsApp');
        }
      } else {
        const seeded = data?.templatesAutoSeeded;
        const submitted = data?.templatesAutoSubmitted;
        const autoErr = data?.templatesAutoError;
        if (autoErr) {
          toastSuccess(
            'Connected',
            `Force AI WhatsApp connected — but template auto-submit failed: ${autoErr}. Visit Templates tab to retry.`
          );
        } else if (seeded && seeded > 0) {
          toastSuccess(
            'Connected + templates submitted',
            `${seeded} template${seeded === 1 ? '' : 's'} seeded, ${submitted ?? 0} pending Meta approval (~10min–24h).`
          );
        } else {
          toastSuccess('Connected', 'Force AI WhatsApp Business Platform connected');
        }
        setApiKeyInput('');
        await fetchConfig();
      }
    } catch {
      toastError('Connection failed', 'An unexpected error occurred');
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
        toastError('Disconnect failed', error.message || 'Could not disconnect');
      } else {
        toastSuccess('Disconnected', 'Force WhatsApp integration removed');
        await fetchConfig();
      }
    } catch {
      toastError('Disconnect failed', 'An unexpected error occurred');
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
          toastError('Connect first', 'Please connect a WBS API key before enabling notifications');
        } else {
          toastError('Save failed', error.message || 'Could not save settings');
        }
      } else {
        toastSuccess('Saved', 'WhatsApp notification settings updated');
        await fetchConfig();
      }
    } catch {
      toastError('Save failed', 'An unexpected error occurred');
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
        toastError('Save failed', error.message || 'Could not update WA ordering setting');
        // Revert optimistic update
        setWaOrderingEnabled(!newValue);
      } else {
        toastSuccess(
          newValue ? 'WA ordering enabled' : 'WA ordering disabled',
          newValue
            ? 'Customers can now order directly via WhatsApp DM.'
            : 'WhatsApp DM ordering has been turned off.'
        );
        await fetchConfig();
      }
    } catch {
      toastError('Save failed', 'An unexpected error occurred');
      setWaOrderingEnabled(!newValue);
    } finally {
      setSavingWaOrdering(false);
    }
  };

  // Derived state: treat hasApiKey+wbsEnabled as connected, even if connectedTenant is null
  const isConnected = config.hasApiKey && config.wbsEnabled;
  const tenantDetailsAvailable = isConnected && config.connectedTenant !== null;
  const tenantDetailsFailed = isConnected && config.connectedTenant === null;
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
            <h3 className="font-medium text-foreground">Connect Force AI WhatsApp</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Paste the API key generated in your Force AI WhatsApp Business Platform admin to link
              this store.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="wbsApiKey" className="text-sm font-medium text-foreground">
              Force AI WhatsApp API Key
            </label>
            <input
              id="wbsApiKey"
              type="password"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              placeholder="Paste key from WBS admin → Client → Force AI Store Bridge"
              autoComplete="new-password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-muted-foreground">
              Generate the key in WBS admin → Clients → Force AI Store Bridge icon. Paste it here — the
              key is verified immediately.
            </p>
          </div>
          <Button onClick={handleConnect} disabled={connecting || !apiKeyInput.trim()}>
            {connecting ? 'Connecting...' : 'Connect'}
          </Button>
        </div>
      )}

      {/* Key set but wbsEnabled=false */}
      {keySetNotEnabled && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
          <div>
            <h3 className="font-medium text-foreground">Finish connecting Force AI WhatsApp</h3>
            <p className="text-sm text-muted-foreground mt-1">
              An API key is saved but WhatsApp notifications aren&apos;t enabled yet. Select your
              templates below and enable to activate.
            </p>
          </div>
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="text-red-600 border-red-300"
              onClick={handleDisconnect}
              disabled={saving}
            >
              {saving ? 'Disconnecting...' : 'Remove key'}
            </Button>
          </div>
        </div>
      )}

      {/* Connected banner */}
      {isConnected && (
        <>
          <div className="rounded-xl border border-green-200 bg-green-50 dark:border-green-900/50 dark:bg-green-950/30 p-4 flex items-start justify-between gap-4">
            <div>
              {tenantDetailsAvailable && config.connectedTenant ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-green-700 dark:text-green-400 font-medium">
                      Connected to {config.connectedTenant.businessName}
                    </span>
                    {config.connectedTenant.phoneNumber && (
                      <span className="text-sm text-green-600 dark:text-green-500">
                        ({config.connectedTenant.phoneNumber})
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">
                    {templates.length} approved template{templates.length !== 1 ? 's' : ''}{' '}
                    available
                  </p>
                </>
              ) : (
                <div>
                  <span className="text-green-700 dark:text-green-400 font-medium">
                    Connected — key saved and active
                  </span>
                  {tenantDetailsFailed && (
                    <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">
                      {config.connectedTenantError === 'invalid_api_key'
                        ? 'The API key may be invalid. Templates sending will fail — disconnect and re-key.'
                        : "Couldn't reach WBS to load business details. Key is saved and working."}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 flex-shrink-0">
              {tenantDetailsFailed && (
                <Button size="sm" variant="outline" onClick={fetchConfig} disabled={loading}>
                  Retry
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="text-red-600 border-red-300"
                onClick={handleDisconnect}
                disabled={saving}
              >
                {saving ? 'Disconnecting...' : 'Disconnect'}
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
                <h3 className="font-medium text-foreground">Enable WhatsApp Notifications</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Master switch for outbound WhatsApp messages. Per-event templates and channel
                  choices live in the Order Updates tab.
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
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>

          {/* Customer ordering via WhatsApp DM */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h3 className="font-medium text-foreground">Customer ordering via WhatsApp DM</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  When enabled, customers who DM the store&apos;s WhatsApp number can browse + order
                  directly. The bot will guide them through delivery + payment, then a draft order
                  lands here ready to fulfill.
                </p>
                <p className="text-xs text-muted-foreground mt-1.5 italic">
                  Default off — opt in when you&apos;re ready to handle bot-guided orders.
                </p>
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
