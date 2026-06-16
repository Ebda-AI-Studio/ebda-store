'use client';

/**
 * TemplatesTab — extracted from /stores/[id]/wa-templates/page.tsx.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button, useToast } from '@force/ui';
import { apiGet, apiPost, apiPut } from '../../lib/api';

const Icon = {
  Sparkles: (p: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
    >
      <path d="M12 3v3M12 18v3M21 12h-3M6 12H3M18.36 5.64l-2.12 2.12M7.76 16.24l-2.12 2.12M18.36 18.36l-2.12-2.12M7.76 7.76L5.64 5.64" />
    </svg>
  ),
  Refresh: (p: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  ),
  Send: (p: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
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
  Pause: (p: { className?: string }) => (
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
      <line x1="10" y1="9" x2="10" y2="15" />
      <line x1="14" y1="9" x2="14" y2="15" />
    </svg>
  ),
  FileText: (p: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
  Lang: (p: { className?: string }) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
    >
      <path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6" />
    </svg>
  ),
};

interface TemplateRow {
  id: string;
  sourceKey: string;
  language: 'en' | 'ar';
  metaName: string;
  category: string;
  body: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled';
  rejectionReason: string | null;
  metaTemplateId: string | null;
  lastSyncedAt: string | null;
  updatedAt: string;
}

interface ListResponse {
  rows: TemplateRow[];
  catalog: unknown[];
  sourceKeys: string[];
}

interface WbsConfigForToggle {
  wbsTemplateUseLogoHeader: boolean;
  storeHasLogo: boolean;
}

const SOURCE_KEY_LABELS: Record<string, string> = {
  orderPaid: 'Order Paid',
  orderShipped: 'Order Shipped',
  orderDelivered: 'Order Delivered',
  welcomeBack: 'Welcome Back',
  cartAbandoned: 'Cart Abandoned',
  paymentLink: 'Payment Link',
};

function StatusBadge({ status }: { status: TemplateRow['status'] }) {
  const map: Record<TemplateRow['status'], { label: string; cls: string; icon: React.ReactNode }> =
    {
      draft: {
        label: 'Draft',
        cls: 'bg-gray-100 text-gray-700 border-gray-200',
        icon: <Icon.FileText className="h-3 w-3" />,
      },
      pending: {
        label: 'Pending Meta',
        cls: 'bg-amber-50 text-amber-700 border-amber-200',
        icon: <Icon.Clock className="h-3 w-3" />,
      },
      approved: {
        label: 'Approved',
        cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        icon: <Icon.Check className="h-3 w-3" />,
      },
      rejected: {
        label: 'Rejected',
        cls: 'bg-red-50 text-red-700 border-red-200',
        icon: <Icon.Alert className="h-3 w-3" />,
      },
      paused: {
        label: 'Paused',
        cls: 'bg-orange-50 text-orange-700 border-orange-200',
        icon: <Icon.Pause className="h-3 w-3" />,
      },
      disabled: {
        label: 'Disabled',
        cls: 'bg-gray-100 text-gray-500 border-gray-200',
        icon: <Icon.Pause className="h-3 w-3" />,
      },
    };
  const { label, cls, icon } = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {icon}
      {label}
    </span>
  );
}

export function TemplatesTab({ storeId }: { storeId: string }) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [data, setData] = useState<ListResponse | null>(null);
  const [wbsConfig, setWbsConfig] = useState<WbsConfigForToggle | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingLogoToggle, setSavingLogoToggle] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tmplResp, cfgResp] = await Promise.all([
        apiGet<ListResponse>(`/api/v1/stores/${storeId}/wa-templates`),
        apiGet<WbsConfigForToggle>(`/api/v1/stores/${storeId}/integrations/wbs`),
      ]);
      if (tmplResp.error) throw new Error(tmplResp.error.message || 'Failed to load');
      if (tmplResp.data) setData(tmplResp.data);
      if (cfgResp.data) {
        setWbsConfig({
          wbsTemplateUseLogoHeader: Boolean(cfgResp.data.wbsTemplateUseLogoHeader),
          storeHasLogo: Boolean(cfgResp.data.storeHasLogo),
        });
      }
    } catch (err) {
      toastError('Failed to load templates', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [storeId, toastError]);

  const toggleLogoHeader = async (next: boolean) => {
    setSavingLogoToggle(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        wbsTemplateUseLogoHeader: next,
      });
      if (error) throw new Error(error.message || 'Save failed');
      setWbsConfig(c => (c ? { ...c, wbsTemplateUseLogoHeader: next } : c));
      toastSuccess(
        next ? 'Logo header enabled' : 'Logo header disabled',
        next
          ? 'Next template generation/sync will include your store logo as the message header image.'
          : 'Future templates will be generated without a header image.'
      );
    } catch (err) {
      toastError('Save failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSavingLogoToggle(false);
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    function onFocus() {
      load();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const generate = async () => {
    setGenerating(true);
    try {
      const { data: payload, error } = await apiPost<{ created: number; message?: string }>(
        `/api/v1/stores/${storeId}/wa-templates/generate`,
        {}
      );
      if (error) throw new Error(error.message || 'Generate failed');
      const created = payload?.created ?? 0;
      toastSuccess(
        created > 0 ? `Created ${created} templates` : 'No new templates',
        payload?.message ||
          (created > 0
            ? 'Click Sync to submit them to Meta.'
            : 'All canonical templates are already seeded.')
      );
      await load();
    } catch (err) {
      toastError('Failed to generate templates', err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const { data: payload, error } = await apiPost<{ submitted: number; message?: string }>(
        `/api/v1/stores/${storeId}/wa-templates/sync`,
        {}
      );
      if (error) throw new Error(error.message || 'Sync failed');
      const submitted = payload?.submitted ?? 0;
      toastSuccess(
        submitted > 0 ? `Submitted ${submitted} templates to Meta` : 'No drafts to sync',
        submitted > 0
          ? 'Approval typically takes 10 minutes to 24 hours. Status will update automatically.'
          : payload?.message || 'All templates have already been submitted.'
      );
      await load();
    } catch (err) {
      toastError('Sync failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const [resetting, setResetting] = useState(false);
  const resetRejected = async () => {
    setResetting(true);
    try {
      const { data: payload, error } = await apiPost<{ reset: number; message?: string }>(
        `/api/v1/stores/${storeId}/wa-templates/reset-rejected`,
        {}
      );
      if (error) throw new Error(error.message || 'Reset failed');
      const reset = payload?.reset ?? 0;
      toastSuccess(
        reset > 0 ? `Reset ${reset} rejected templates` : 'No rejected templates',
        payload?.message ||
          (reset > 0
            ? 'Templates flipped to draft with the latest canonical body. Click Sync to resubmit.'
            : 'There are no rejected templates to reset.')
      );
      await load();
    } catch (err) {
      toastError('Reset failed', err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  };

  const groupedRows = (data?.rows || []).reduce<Record<string, TemplateRow[]>>((acc, row) => {
    (acc[row.sourceKey] ||= []).push(row);
    return acc;
  }, {});

  const sourceKeys = data?.sourceKeys || [];
  const hasAnyRows = (data?.rows || []).length > 0;
  const draftCount = (data?.rows || []).filter(r => r.status === 'draft').length;
  const rejectedCount = (data?.rows || []).filter(r => r.status === 'rejected').length;

  return (
    <div className="max-w-3xl space-y-6">
      {/* Top actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={generate}
          disabled={generating || loading}
          className="bg-orange-500 hover:bg-orange-600"
        >
          <Icon.Sparkles className="me-2 h-4 w-4" />
          {generating ? 'Generating…' : hasAnyRows ? 'Add missing defaults' : 'Generate defaults'}
        </Button>
        <Button
          onClick={sync}
          disabled={syncing || loading || draftCount === 0}
          variant={draftCount > 0 ? 'default' : 'outline'}
        >
          <Icon.Send className="me-2 h-4 w-4" />
          {syncing
            ? 'Submitting…'
            : draftCount > 0
              ? `Sync ${draftCount} to Meta`
              : 'Nothing to sync'}
        </Button>
        {rejectedCount > 0 && (
          <Button
            onClick={resetRejected}
            disabled={resetting || loading}
            variant="outline"
            title="Refresh rejected templates from the latest canonical body, then click Sync to resubmit"
          >
            <Icon.Refresh className={`me-2 h-4 w-4 ${resetting ? 'animate-spin' : ''}`} />
            {resetting ? 'Resetting…' : `Reset ${rejectedCount} rejected to draft`}
          </Button>
        )}
        <Button onClick={load} disabled={loading} variant="outline">
          <Icon.Refresh className={`me-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Logo-as-header opt-in */}
      {wbsConfig && (
        <div
          className={`rounded-lg border p-4 ${wbsConfig.storeHasLogo ? 'bg-card border-border' : 'bg-muted/40 border-border opacity-75'}`}
        >
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={wbsConfig.wbsTemplateUseLogoHeader}
              disabled={!wbsConfig.storeHasLogo || savingLogoToggle}
              onChange={e => toggleLogoHeader(e.target.checked)}
              className="sr-only peer"
            />
            <div className="relative w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm text-foreground">
                Use my store logo as the WhatsApp message header
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Customers see your store logo at the top of every order-update message. Applied when
                you next generate or sync templates.
              </p>
              {!wbsConfig.storeHasLogo && (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                  Set a store logo first under Branding before enabling this.
                </p>
              )}
              {wbsConfig.wbsTemplateUseLogoHeader && wbsConfig.storeHasLogo && (
                <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1">
                  On. Next sync will upload your logo to Meta and submit templates with image
                  headers.
                </p>
              )}
            </div>
          </label>
        </div>
      )}

      {/* Template list */}
      {loading && !data ? (
        <div className="rounded-md border bg-card p-8 text-center text-sm text-muted-foreground">
          Loading templates…
        </div>
      ) : !hasAnyRows ? (
        <div className="rounded-md border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          <Icon.Sparkles className="mx-auto mb-2 h-8 w-8 text-orange-500" />
          <p className="font-medium text-foreground">No templates set up yet.</p>
          <p className="mt-1">
            Click <strong>Generate defaults</strong> to add the 12 canonical Force AI templates as
            drafts.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sourceKeys.map(key => {
            const rows = groupedRows[key] || [];
            if (rows.length === 0) return null;
            return (
              <div key={key} className="rounded-lg border bg-card shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/40">
                  <div>
                    <h3 className="font-semibold text-foreground">
                      {SOURCE_KEY_LABELS[key] || key}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">{rows[0]?.category}</p>
                  </div>
                </div>
                <div className="divide-y divide-border">
                  {rows.map(row => (
                    <div
                      key={row.id}
                      className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3"
                    >
                      <div className="flex items-center gap-2 sm:w-24 shrink-0">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-3.5 w-3.5 text-muted-foreground"
                        >
                          <path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6" />
                        </svg>
                        <span className="text-xs font-medium text-muted-foreground uppercase">
                          {row.language}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                          {row.body}
                        </p>
                        {row.rejectionReason && (
                          <p className="mt-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded px-2 py-1">
                            Meta rejected: {row.rejectionReason}
                          </p>
                        )}
                        <p className="mt-1.5 text-[10.5px] text-muted-foreground font-mono">
                          {row.metaName}
                          {row.lastSyncedAt && (
                            <> · last sync {new Date(row.lastSyncedAt).toLocaleString()}</>
                          )}
                        </p>
                      </div>
                      <div className="shrink-0">
                        <StatusBadge status={row.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-md border bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800 p-3 text-xs text-blue-800 dark:text-blue-300">
        <strong>How it works:</strong> Click <em>Generate defaults</em> to create the canonical
        templates as drafts. Click <em>Sync to Meta</em> to submit them. Meta reviews each template;
        approval typically takes 10 minutes to 24 hours.
      </div>
    </div>
  );
}
