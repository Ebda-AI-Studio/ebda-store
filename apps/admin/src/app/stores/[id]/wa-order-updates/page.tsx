'use client';

/**
 * Order Updates — WhatsApp lifecycle event configuration.
 *
 * Lets the merchant pick WHICH lifecycle events trigger an automatic
 * WhatsApp message to the customer. Reads + writes Store.wbsTemplates
 * (the JSON column the existing order-whatsapp-notify Inngest function
 * already reads). Approval status pulled from the connected WBS metadata
 * (which lists Meta-approved template names per language).
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';

const Icon = {
  Check: (p: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  Clock: (p: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  Alert: (p: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
};

interface AvailableTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  variableCount: number;
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
  hasApiKey: boolean;
  wbsTemplates: WbsTemplates | null;
  connectedTenant: {
    businessName: string;
    availableTemplates: AvailableTemplate[];
  } | null;
}

type EventKey = 'orderPaid' | 'orderShipped' | 'orderDelivered';

interface EventDef {
  key: EventKey;
  label: string;
  description: string;
  templateBase: string; // base name like 'order_paid_v1'
}

const EVENTS: EventDef[] = [
  {
    key: 'orderPaid',
    label: 'Order paid',
    description: 'Send automatically the moment a customer completes payment.',
    templateBase: 'order_paid_v1',
  },
  {
    key: 'orderShipped',
    label: 'Order shipped',
    description: 'Send when the order is marked as shipped (includes tracking number variable).',
    templateBase: 'order_shipped_v1',
  },
  {
    key: 'orderDelivered',
    label: 'Order delivered',
    description: 'Send when the order is marked as delivered.',
    templateBase: 'order_delivered_v1',
  },
];

function findApprovedTemplate(
  available: AvailableTemplate[],
  baseName: string,
  language: string
): AvailableTemplate | null {
  // Match templates ending in the canonical purpose suffix (handles both
  // force_<base> and <store-slug>_<base> naming conventions).
  return (
    available.find(
      t =>
        t.language === language &&
        (t.name === `force_${baseName}` || t.name.endsWith(`_${baseName}`)) &&
        t.status.toUpperCase() === 'APPROVED'
    ) || null
  );
}

function findAnyTemplate(
  available: AvailableTemplate[],
  baseName: string,
  language: string
): AvailableTemplate | null {
  return (
    available.find(
      t =>
        t.language === language &&
        (t.name === `force_${baseName}` || t.name.endsWith(`_${baseName}`))
    ) || null
  );
}

export default function WaOrderUpdatesPage() {
  const params = useParams();
  const storeId = params.id as string;
  const { success: toastSuccess, error: toastError } = useToast();

  const [config, setConfig] = useState<WbsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState<'en' | 'ar'>('en');
  const [enabled, setEnabled] = useState<Record<EventKey, boolean>>({
    orderPaid: false,
    orderShipped: false,
    orderDelivered: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await apiGet<WbsConfig>(`/api/v1/stores/${storeId}/integrations/wbs`);
      if (error) throw new Error(error.message || 'Load failed');
      if (data) {
        setConfig(data);
        const t = data.wbsTemplates || {};
        setEnabled({
          orderPaid: Boolean(t.orderPaid?.name),
          orderShipped: Boolean(t.orderShipped?.name),
          orderDelivered: Boolean(t.orderDelivered?.name),
        });
        if (t.orderPaid?.languageCode === 'ar') setLanguage('ar');
      }
    } catch (e) {
      toastError('Failed to load', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [storeId, toastError]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      // Build the new wbsTemplates JSON. For each event toggled on, find
      // a matching approved template at Meta in the chosen language and
      // store its full name. If none approved, save anyway so it'll start
      // working once approval comes through.
      const available = config.connectedTenant?.availableTemplates || [];
      const nextTemplates: WbsTemplates = {};
      for (const evt of EVENTS) {
        if (!enabled[evt.key]) continue;
        const approved = findApprovedTemplate(available, evt.templateBase, language);
        const any = approved || findAnyTemplate(available, evt.templateBase, language);
        if (any) {
          nextTemplates[evt.key] = { name: any.name, languageCode: language };
        }
      }

      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        wbsTemplates: nextTemplates,
      });
      if (error) throw new Error(error.message || 'Save failed');
      toastSuccess('Saved', 'Order update settings updated.');
      await load();
    } catch (e) {
      toastError('Save failed', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const connected = config?.hasApiKey && config?.connectedTenant !== null;
  const available = config?.connectedTenant?.availableTemplates || [];

  return (
    <AdminLayout title="Order Updates">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">📨 Order Updates</h1>
          <p className="text-sm text-gray-600">
            Automatic WhatsApp messages to customers on each step of their order. Powered by your
            approved WhatsApp templates from the Force WhatsApp Business Platform.
          </p>
        </header>

        {!connected && !loading && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <div className="flex items-start gap-2">
              <Icon.Alert className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <strong>Not connected yet.</strong>
                <p className="mt-1">
                  Connect to Force WhatsApp Business Platform first under{' '}
                  <a href={`/stores/${storeId}/integrations/wbs`} className="underline font-medium">
                    Settings → WhatsApp Business
                  </a>
                  , then come back here.
                </p>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="rounded-md border bg-white p-8 text-center text-sm text-gray-500">
            Loading…
          </div>
        ) : (
          connected && (
            <>
              {/* Language picker */}
              <div className="rounded-lg border bg-white p-4">
                <label htmlFor="lang" className="text-sm font-semibold text-gray-700">
                  Message language
                </label>
                <p className="text-xs text-gray-500 mt-0.5">
                  Templates with this language code must be approved by Meta.
                </p>
                <select
                  id="lang"
                  value={language}
                  onChange={e => setLanguage(e.target.value as 'en' | 'ar')}
                  className="mt-2 w-full rounded-md border bg-white px-3 py-2 text-sm"
                >
                  <option value="en">English (en)</option>
                  <option value="ar">Arabic (ar)</option>
                </select>
              </div>

              {/* Events */}
              <div className="space-y-3">
                {EVENTS.map(evt => {
                  const approved = findApprovedTemplate(available, evt.templateBase, language);
                  const any = findAnyTemplate(available, evt.templateBase, language);
                  const matched = approved || any;
                  const status = approved
                    ? 'approved'
                    : any
                      ? (any.status.toLowerCase() as 'pending' | 'rejected' | 'paused' | 'disabled')
                      : 'missing';
                  const enabledForEvent = enabled[evt.key];
                  return (
                    <div key={evt.key} className="rounded-lg border bg-white p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <h3 className="font-semibold text-gray-900">{evt.label}</h3>
                          <p className="text-sm text-gray-600 mt-0.5">{evt.description}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                            {matched && (
                              <span className="font-mono text-gray-500">{matched.name}</span>
                            )}
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${
                                status === 'approved'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : status === 'pending'
                                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                                    : status === 'missing'
                                      ? 'bg-gray-100 text-gray-600 border-gray-200'
                                      : 'bg-red-50 text-red-700 border-red-200'
                              }`}
                            >
                              {status === 'approved' && <Icon.Check className="h-3 w-3" />}
                              {status === 'pending' && <Icon.Clock className="h-3 w-3" />}
                              {status === 'missing' && <Icon.Alert className="h-3 w-3" />}
                              {status === 'missing' ? 'Template not found' : status}
                            </span>
                          </div>
                          {status === 'missing' && (
                            <p className="mt-2 text-xs text-gray-500">
                              Generate templates first via{' '}
                              <a
                                href={`/stores/${storeId}/wa-templates`}
                                className="underline font-medium"
                              >
                                WhatsApp Templates
                              </a>
                              .
                            </p>
                          )}
                        </div>
                        <label className="inline-flex items-center cursor-pointer shrink-0">
                          <input
                            type="checkbox"
                            checked={enabledForEvent}
                            onChange={e => setEnabled(s => ({ ...s, [evt.key]: e.target.checked }))}
                            disabled={status === 'missing'}
                            className="sr-only peer"
                          />
                          <div className="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed" />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Save */}
              <div className="flex justify-end">
                <Button
                  onClick={save}
                  disabled={saving || loading}
                  className="bg-orange-500 hover:bg-orange-600"
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>

              {/* Footer help */}
              <div className="rounded-md border bg-blue-50/50 border-blue-200 p-3 text-xs text-blue-800">
                <strong>How it works:</strong> when a customer&apos;s order transitions to one of
                these states, the FWB API fires the corresponding WhatsApp template via your Force
                WhatsApp Business Platform integration. Variables (customer name, order number,
                total, store name, tracking number) are passed at send time. Customers receive the
                message on the WhatsApp number they used at checkout.
              </div>
            </>
          )
        )}
      </div>
    </AdminLayout>
  );
}
