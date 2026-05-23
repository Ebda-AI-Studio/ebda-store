'use client';

/**
 * OrderUpdatesTab — extracted from /stores/[id]/wa-order-updates/page.tsx.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button, useToast } from '@force/ui';
import { apiGet, apiPut } from '../../lib/api';

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

interface TemplateChannels {
  whatsapp: boolean;
  email: boolean;
}

interface TemplateEntry {
  name: string;
  languageCode: string;
  /** Per-event channel toggles. Absent = both on (backward-compatible). */
  channels?: TemplateChannels;
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
  templateBase: string;
}

const EVENTS: EventDef[] = [
  {
    key: 'orderPaid',
    label: 'Order paid',
    description: 'Send automatically the moment a customer completes payment.',
    // Version-agnostic base (no _v1/_v2 suffix). The matcher accepts
    // any version of the same purpose so v2 templates resolve after
    // a policy-driven rewording without stranding the merchant on
    // "Template not found".
    templateBase: 'order_paid',
  },
  {
    key: 'orderShipped',
    label: 'Order shipped',
    description: 'Send when the order is marked as shipped (includes tracking number variable).',
    templateBase: 'order_shipped',
  },
  {
    key: 'orderDelivered',
    label: 'Order delivered',
    description: 'Send when the order is marked as delivered.',
    templateBase: 'order_delivered',
  },
];

/** Default channel state: both on when not previously saved. */
const DEFAULT_CHANNELS: TemplateChannels = { whatsapp: true, email: true };

/**
 * Returns the highest-version template whose name matches the base
 * pattern, optionally filtered by APPROVED status. Matching rules:
 *   - Exact: `force_<base>` OR `<storeSlug>_<base>` (legacy v1 without suffix)
 *   - Versioned: `force_<base>_v<N>` OR `<storeSlug>_<base>_v<N>` (any N)
 * When multiple matches exist (e.g. v1 approved + v2 approved), we pick
 * the highest N. v1 with no suffix ranks at 1 for comparison.
 */
function extractVersion(name: string, base: string): number | null {
  // Try exact match (legacy v1 without suffix)
  if (name === `force_${base}` || name.endsWith(`_${base}`)) return 1;
  // Try versioned match: <prefix>_<base>_v<N>
  const m = name.match(new RegExp(`^(?:force|.+?)_${base}_v(\\d+)$`));
  return m ? parseInt(m[1], 10) : null;
}

function findApprovedTemplate(
  available: AvailableTemplate[],
  baseName: string,
  language: string
): AvailableTemplate | null {
  const candidates = available
    .filter(t => t.language === language && t.status.toUpperCase() === 'APPROVED')
    .map(t => ({ t, v: extractVersion(t.name, baseName) }))
    .filter((x): x is { t: AvailableTemplate; v: number } => x.v !== null)
    .sort((a, b) => b.v - a.v);
  return candidates[0]?.t ?? null;
}

function findAnyTemplate(
  available: AvailableTemplate[],
  baseName: string,
  language: string
): AvailableTemplate | null {
  const candidates = available
    .filter(t => t.language === language)
    .map(t => ({ t, v: extractVersion(t.name, baseName) }))
    .filter((x): x is { t: AvailableTemplate; v: number } => x.v !== null)
    .sort((a, b) => b.v - a.v);
  return candidates[0]?.t ?? null;
}

export function OrderUpdatesTab({ storeId }: { storeId: string }) {
  const { success: toastSuccess, error: toastError, warning: toastWarning } = useToast();
  const [config, setConfig] = useState<WbsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState<'en' | 'ar'>('en');
  const [enabled, setEnabled] = useState<Record<EventKey, boolean>>({
    orderPaid: false,
    orderShipped: false,
    orderDelivered: false,
  });
  /** Per-event channel toggles. Both default to true when not present in saved config. */
  const [channels, setChannels] = useState<Record<EventKey, TemplateChannels>>({
    orderPaid: { ...DEFAULT_CHANNELS },
    orderShipped: { ...DEFAULT_CHANNELS },
    orderDelivered: { ...DEFAULT_CHANNELS },
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
        // Restore saved channel state; default both ON when absent
        setChannels({
          orderPaid: t.orderPaid?.channels ?? { ...DEFAULT_CHANNELS },
          orderShipped: t.orderShipped?.channels ?? { ...DEFAULT_CHANNELS },
          orderDelivered: t.orderDelivered?.channels ?? { ...DEFAULT_CHANNELS },
        });
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
      const available = config.connectedTenant?.availableTemplates || [];
      const nextTemplates: WbsTemplates = {};
      for (const evt of EVENTS) {
        if (!enabled[evt.key]) continue;
        const approved = findApprovedTemplate(available, evt.templateBase, language);
        const any = approved || findAnyTemplate(available, evt.templateBase, language);
        if (any) {
          const evtChannels = channels[evt.key];
          // Warn when both channels are off — the event becomes silent
          if (!evtChannels.whatsapp && !evtChannels.email) {
            toastWarning?.(
              'Silent event',
              `${EVENTS.find(e => e.key === evt.key)?.label} has both channels off — no notification will be sent.`
            );
          }
          nextTemplates[evt.key] = {
            name: any.name,
            languageCode: language,
            channels: evtChannels,
          };
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
    <div className="mx-auto max-w-3xl space-y-6">
      {!connected && !loading && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <Icon.Alert className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <strong>Not connected yet.</strong>
              <p className="mt-1">
                Connect to Force WhatsApp Business Platform first from the{' '}
                <strong>Connection</strong> tab, then come back here.
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
            <div className="rounded-lg border bg-white p-4">
              <label htmlFor="lang-ou" className="text-sm font-semibold text-gray-700">
                Message language
              </label>
              <p className="text-xs text-gray-500 mt-0.5">
                Templates with this language code must be approved by Meta.
              </p>
              <select
                id="lang-ou"
                value={language}
                onChange={e => setLanguage(e.target.value as 'en' | 'ar')}
                className="mt-2 w-full rounded-md border bg-white px-3 py-2 text-sm"
              >
                <option value="en">English (en)</option>
                <option value="ar">Arabic (ar)</option>
              </select>
            </div>

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
                const evtChannels = channels[evt.key];
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
                            Generate templates first from the <strong>Templates</strong> tab.
                          </p>
                        )}

                        {/* Channel toggles — only shown when event is enabled */}
                        {enabledForEvent && status !== 'missing' && (
                          <div className="mt-3 flex flex-wrap items-center gap-4">
                            <span className="text-xs font-medium text-gray-500">Send via:</span>
                            {/* WhatsApp channel toggle */}
                            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={evtChannels.whatsapp}
                                onChange={e =>
                                  setChannels(prev => ({
                                    ...prev,
                                    [evt.key]: { ...prev[evt.key], whatsapp: e.target.checked },
                                  }))
                                }
                                className="h-3.5 w-3.5 rounded border-gray-300 accent-green-500"
                              />
                              <span className="text-xs text-gray-700">WhatsApp</span>
                            </label>
                            {/* Email channel toggle */}
                            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={evtChannels.email}
                                onChange={e =>
                                  setChannels(prev => ({
                                    ...prev,
                                    [evt.key]: { ...prev[evt.key], email: e.target.checked },
                                  }))
                                }
                                className="h-3.5 w-3.5 rounded border-gray-300 accent-blue-500"
                              />
                              <span className="text-xs text-gray-700">Email</span>
                            </label>
                            {!evtChannels.whatsapp && !evtChannels.email && (
                              <span className="text-xs text-amber-600 font-medium">
                                Both off — event will be silent
                              </span>
                            )}
                          </div>
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

            <div className="flex justify-end">
              <Button
                onClick={save}
                disabled={saving || loading}
                className="bg-orange-500 hover:bg-orange-600"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>

            <div className="rounded-md border bg-blue-50/50 border-blue-200 p-3 text-xs text-blue-800">
              <strong>How it works:</strong> when a customer&apos;s order transitions to one of
              these states, the FWB API fires the corresponding WhatsApp template via your Force
              WhatsApp Business Platform integration. Use the channel checkboxes to control which
              notification methods are active per event.
            </div>
          </>
        )
      )}
    </div>
  );
}
