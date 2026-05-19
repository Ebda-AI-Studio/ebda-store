'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../../lib/api';

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
}

const DEFAULT_CONFIG: WbsConfig = {
  wbsEnabled: false,
  wbsClientId: null,
  wbsApiKeyMasked: '',
  hasApiKey: false,
  wbsTemplates: null,
  connectedTenant: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a template for the dropdown option label */
function templateLabel(t: AvailableTemplate): string {
  return `${t.name} (${t.language}) — ${t.category}`;
}

/** Build a unique value string for a template option */
function templateValue(t: AvailableTemplate): string {
  return `${t.name}:::${t.language}`;
}

/** Parse a template value string back to a TemplateEntry */
function parseTemplateValue(value: string): TemplateEntry | null {
  const [name, languageCode] = value.split(':::');
  if (!name || !languageCode) return null;
  return { name, languageCode };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function WbsIntegrationPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: toastError } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<WbsConfig>(DEFAULT_CONFIG);

  // Step 1 state (connect key)
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [connecting, setConnecting] = useState(false);

  // Step 2 state (template selection)
  const [selectedTemplates, setSelectedTemplates] = useState<WbsTemplates>({});
  const [enableToggle, setEnableToggle] = useState(false);

  const fetchConfig = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    const { data } = await apiGet<{ data: WbsConfig }>(
      `/api/v1/stores/${storeId}/integrations/wbs`
    );
    if (data?.data) {
      const cfg = data.data;
      setConfig(cfg);
      setEnableToggle(cfg.wbsEnabled);
      setSelectedTemplates(cfg.wbsTemplates || {});
    }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // ── Step 1: Connect ──────────────────────────────────────────────────────────

  const handleConnect = async () => {
    if (!apiKeyInput.trim()) return;
    setConnecting(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        wbsApiKey: apiKeyInput.trim(),
      });
      if (error) {
        if (error.code === 'INVALID_API_KEY' || error.message?.includes('invalid_api_key')) {
          toastError('Invalid key', 'The API key was rejected. Generate a new key in WBS admin.');
        } else {
          toastError('Connection failed', error.message || 'Could not connect to Force WhatsApp');
        }
      } else {
        toastSuccess('Connected', 'Force WhatsApp Business Platform connected');
        setApiKeyInput('');
        await fetchConfig();
      }
    } catch {
      toastError('Connection failed', 'An unexpected error occurred');
    } finally {
      setConnecting(false);
    }
  };

  // ── Step 2: Disconnect ───────────────────────────────────────────────────────

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

  // ── Step 2: Save templates + enable toggle ───────────────────────────────────

  const allTemplatesPicked = Boolean(
    selectedTemplates.orderPaid?.name &&
    selectedTemplates.orderShipped?.name &&
    selectedTemplates.orderDelivered?.name
  );

  const handleSaveTemplates = async () => {
    setSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        wbsTemplates: selectedTemplates,
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

  // ── Template dropdown helpers ─────────────────────────────────────────────────

  const selectTemplate = (
    event: 'orderPaid' | 'orderShipped' | 'orderDelivered',
    value: string
  ) => {
    const entry = parseTemplateValue(value);
    setSelectedTemplates(prev => ({
      ...prev,
      [event]: entry || undefined,
    }));
  };

  const templates = config.connectedTenant?.availableTemplates || [];

  // ─────────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <AdminLayout
        title="WhatsApp Notifications"
        subtitle="Force WhatsApp Business Platform integration"
      >
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </AdminLayout>
    );
  }

  const isConnected = config.hasApiKey && config.connectedTenant !== null;
  const isKeySetButUnreachable = config.hasApiKey && config.connectedTenant === null;

  return (
    <AdminLayout
      title="WhatsApp Notifications"
      subtitle="Send automatic order updates to customers via Force WhatsApp Business Platform"
    >
      <div className="max-w-2xl space-y-6">
        {/* ── Step 1: Connect (only shown when not yet connected) ─────────────── */}
        {!isConnected && !isKeySetButUnreachable && (
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
            <div>
              <h3 className="font-medium text-foreground">Connect Force WhatsApp</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Paste the API key generated in your Force WhatsApp Business Platform admin to link
                this store.
              </p>
            </div>

            <div className="space-y-1">
              <label htmlFor="wbsApiKey" className="text-sm font-medium text-foreground">
                Force WhatsApp API Key
              </label>
              <input
                id="wbsApiKey"
                type="password"
                value={apiKeyInput}
                onChange={e => setApiKeyInput(e.target.value)}
                placeholder="Paste key from WBS admin → Client → Force Store Bridge"
                autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="text-xs text-muted-foreground">
                Generate the key in WBS admin → Clients → Force Store Bridge icon. Paste it here —
                the key is verified immediately.
              </p>
            </div>

            <Button onClick={handleConnect} disabled={connecting || !apiKeyInput.trim()}>
              {connecting ? 'Connecting...' : 'Connect'}
            </Button>
          </div>
        )}

        {/* ── Key set but WBS unreachable ──────────────────────────────────────── */}
        {isKeySetButUnreachable && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 p-6 shadow-sm space-y-3">
            <h3 className="font-medium text-amber-900 dark:text-amber-300">
              Key configured — Force WhatsApp currently unreachable
            </h3>
            <p className="text-sm text-amber-800 dark:text-amber-400">
              {config.connectedTenantError === 'invalid_api_key'
                ? 'The API key is no longer valid. Disconnect and generate a new key in WBS admin.'
                : 'Force WhatsApp Business Platform is temporarily unavailable. Template selection will reappear when it reconnects.'}
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={fetchConfig} disabled={loading}>
                Retry
              </Button>
              <Button
                variant="outline"
                className="text-red-600 border-red-300"
                onClick={handleDisconnect}
                disabled={saving}
              >
                {saving ? 'Disconnecting...' : 'Disconnect'}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 2: Configure (only shown when connected) ───────────────────── */}
        {isConnected && config.connectedTenant && (
          <>
            {/* Connected banner */}
            <div className="rounded-xl border border-green-200 bg-green-50 dark:border-green-900/50 dark:bg-green-950/30 p-4 flex items-start justify-between gap-4">
              <div>
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
                  {templates.length} approved template{templates.length !== 1 ? 's' : ''} available
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="text-red-600 border-red-300 flex-shrink-0"
                onClick={handleDisconnect}
                disabled={saving}
              >
                {saving ? 'Disconnecting...' : 'Disconnect'}
              </Button>
            </div>

            {/* Template selection */}
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-5">
              <div>
                <h3 className="font-medium text-foreground">Message Templates</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Select the approved WhatsApp template for each order event.
                </p>
              </div>

              {templates.length === 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 p-4 text-sm text-amber-800 dark:text-amber-300">
                  No approved templates found. Approve templates in your Meta WABA dashboard, then
                  click Retry above.
                </div>
              ) : (
                <>
                  {(
                    [
                      {
                        key: 'orderPaid' as const,
                        label: 'Order Paid',
                        description: 'Sent when a customer completes payment',
                      },
                      {
                        key: 'orderShipped' as const,
                        label: 'Order Shipped',
                        description: 'Sent when the order status changes to Shipped',
                      },
                      {
                        key: 'orderDelivered' as const,
                        label: 'Order Delivered',
                        description: 'Sent when the order status changes to Delivered',
                      },
                    ] as const
                  ).map(({ key, label, description }) => {
                    const current = selectedTemplates[key];
                    const currentValue = current ? templateValue(current as AvailableTemplate) : '';

                    return (
                      <div
                        key={key}
                        className="border-t border-border/50 pt-4 first:border-0 first:pt-0"
                      >
                        <div className="mb-2">
                          <span className="text-sm font-medium text-foreground">{label}</span>
                          <p className="text-xs text-muted-foreground">{description}</p>
                        </div>
                        <select
                          value={currentValue}
                          onChange={e => selectTemplate(key, e.target.value)}
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                        >
                          <option value="">— Select template —</option>
                          {templates.map(t => (
                            <option key={templateValue(t)} value={templateValue(t)}>
                              {templateLabel(t)}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            {/* Enable toggle */}
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium text-foreground">Enable WhatsApp Notifications</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {allTemplatesPicked
                      ? 'Ready to enable — all 3 templates selected.'
                      : 'Select all 3 templates above before enabling.'}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enableToggle}
                  disabled={!allTemplatesPicked}
                  onClick={() => allTemplatesPicked && setEnableToggle(prev => !prev)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed ${
                    enableToggle && allTemplatesPicked ? 'bg-primary' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      enableToggle && allTemplatesPicked ? 'translate-x-6' : 'translate-x-1'
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
          </>
        )}
      </div>
    </AdminLayout>
  );
}
