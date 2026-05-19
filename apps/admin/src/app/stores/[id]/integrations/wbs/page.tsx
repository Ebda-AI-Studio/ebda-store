'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  wbsClientId: string;
  wbsApiKey: string;
  wbsApiKeyMasked: string;
  hasApiKey: boolean;
  wbsTemplates: WbsTemplates;
}

const DEFAULT_CONFIG: WbsConfig = {
  wbsEnabled: false,
  wbsClientId: '',
  wbsApiKey: '',
  wbsApiKeyMasked: '',
  hasApiKey: false,
  wbsTemplates: {
    orderPaid: { name: '', languageCode: 'en' },
    orderShipped: { name: '', languageCode: 'en' },
    orderDelivered: { name: '', languageCode: 'en' },
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function WbsIntegrationPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: toastError } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<WbsConfig>(DEFAULT_CONFIG);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyChanged, setApiKeyChanged] = useState(false);

  const fetchConfig = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    const { data } = await apiGet<{ data: WbsConfig }>(
      `/api/v1/stores/${storeId}/integrations/wbs`
    );
    if (data?.data) {
      const cfg = data.data;
      setConfig({
        ...DEFAULT_CONFIG,
        ...cfg,
        wbsTemplates: {
          orderPaid: cfg.wbsTemplates?.orderPaid || { name: '', languageCode: 'en' },
          orderShipped: cfg.wbsTemplates?.orderShipped || { name: '', languageCode: 'en' },
          orderDelivered: cfg.wbsTemplates?.orderDelivered || { name: '', languageCode: 'en' },
        },
      });
      setApiKeyInput(cfg.hasApiKey ? cfg.wbsApiKeyMasked : '');
    }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const updateTemplate = (
    event: 'orderPaid' | 'orderShipped' | 'orderDelivered',
    field: 'name' | 'languageCode',
    value: string
  ) => {
    setConfig(prev => ({
      ...prev,
      wbsTemplates: {
        ...prev.wbsTemplates,
        [event]: {
          ...prev.wbsTemplates[event],
          [field]: value,
        },
      },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Build templates payload — only include events that have a name
      const templates: WbsTemplates = {};
      if (config.wbsTemplates.orderPaid?.name) {
        templates.orderPaid = config.wbsTemplates.orderPaid;
      }
      if (config.wbsTemplates.orderShipped?.name) {
        templates.orderShipped = config.wbsTemplates.orderShipped;
      }
      if (config.wbsTemplates.orderDelivered?.name) {
        templates.orderDelivered = config.wbsTemplates.orderDelivered;
      }

      const payload: Record<string, unknown> = {
        wbsEnabled: config.wbsEnabled,
        wbsClientId: config.wbsClientId || null,
        wbsTemplates: templates,
      };

      // Only include API key if it was actually changed by the user
      if (apiKeyChanged) {
        payload.wbsApiKey = apiKeyInput || null;
      } else {
        // Pass back the masked value so the server knows not to change it
        payload.wbsApiKey = config.wbsApiKeyMasked || undefined;
      }

      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, payload);

      if (error) {
        toastError('Save failed', error.message || 'Could not save WBS integration settings');
      } else {
        toastSuccess('Saved', 'WhatsApp Business Platform integration updated');
        setApiKeyChanged(false);
        await fetchConfig();
      }
    } catch {
      toastError('Save failed', 'An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  };

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

  return (
    <AdminLayout
      title="WhatsApp Notifications"
      subtitle="Send automatic order updates to customers via Force WhatsApp Business Platform"
    >
      <div className="max-w-2xl space-y-6">
        {/* Enable toggle */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium text-foreground">Enable WhatsApp Notifications</h3>
              <p className="text-sm text-muted-foreground mt-1">
                When enabled, customers receive WhatsApp messages at key order milestones.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={config.wbsEnabled}
              onClick={() => setConfig(prev => ({ ...prev, wbsEnabled: !prev.wbsEnabled }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                config.wbsEnabled ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  config.wbsEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Connection settings */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
          <h3 className="font-medium text-foreground">Connection Settings</h3>

          <div className="space-y-1">
            <label htmlFor="wbsClientId" className="text-sm font-medium text-foreground">
              WBS Client ID
            </label>
            <input
              id="wbsClientId"
              type="text"
              value={config.wbsClientId}
              onChange={e => setConfig(prev => ({ ...prev, wbsClientId: e.target.value }))}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-muted-foreground">
              The Client ID from your Force WhatsApp Business Platform account.
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="wbsApiKey" className="text-sm font-medium text-foreground">
              API Key
            </label>
            <input
              id="wbsApiKey"
              type="password"
              value={apiKeyInput}
              onChange={e => {
                setApiKeyInput(e.target.value);
                setApiKeyChanged(true);
              }}
              placeholder={config.hasApiKey ? 'Enter new key to replace...' : 'Enter API key...'}
              autoComplete="new-password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {config.hasApiKey && !apiKeyChanged && (
              <p className="text-xs text-muted-foreground">
                Current key: {config.wbsApiKeyMasked} — leave blank to keep unchanged.
              </p>
            )}
          </div>
        </div>

        {/* Per-event templates */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-5">
          <div>
            <h3 className="font-medium text-foreground">Message Templates</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Enter the exact template name and language code as registered in your Meta WABA.
              Templates must be approved before orders can trigger them.
            </p>
          </div>

          {(
            [
              {
                key: 'orderPaid' as const,
                label: 'Order Paid',
                description: 'Sent when a customer completes payment',
                hint: 'Variables: {{1}} customer name, {{2}} order number, {{3}} total, {{4}} store name',
              },
              {
                key: 'orderShipped' as const,
                label: 'Order Shipped',
                description: 'Sent when the order status changes to Shipped',
                hint: 'Variables: {{1}} customer name, {{2}} order number, {{3}} total, {{4}} store name, {{5}} tracking number (optional)',
              },
              {
                key: 'orderDelivered' as const,
                label: 'Order Delivered',
                description: 'Sent when the order status changes to Delivered',
                hint: 'Variables: {{1}} customer name, {{2}} order number, {{3}} total, {{4}} store name, {{5}} tracking number (optional)',
              },
            ] as const
          ).map(({ key, label, description, hint }) => (
            <div key={key} className="border-t border-border/50 pt-4 first:border-0 first:pt-0">
              <div className="mb-3">
                <span className="text-sm font-medium text-foreground">{label}</span>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1">
                  <label className="text-xs text-muted-foreground">Template name</label>
                  <input
                    type="text"
                    value={config.wbsTemplates[key]?.name || ''}
                    onChange={e => updateTemplate(key, 'name', e.target.value)}
                    placeholder="e.g. order_confirmation"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Language</label>
                  <input
                    type="text"
                    value={config.wbsTemplates[key]?.languageCode || 'en'}
                    onChange={e => updateTemplate(key, 'languageCode', e.target.value)}
                    placeholder="en"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground/70">{hint}</p>
            </div>
          ))}
        </div>

        {/* Save */}
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Integration Settings'}
          </Button>
        </div>
      </div>
    </AdminLayout>
  );
}
