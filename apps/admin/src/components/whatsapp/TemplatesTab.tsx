'use client';

/**
 * TemplatesTab — extracted from /stores/[id]/wa-templates/page.tsx.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button, useToast } from '@force/ui';
import { apiGet, apiPost, apiPut } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { withNumerals } from '@force/shared';

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

function StatusBadge({ status }: { status: TemplateRow['status'] }) {
  const t = useT('whatsappIntegration.templates');
  const map: Record<TemplateRow['status'], { label: string; cls: string; icon: React.ReactNode }> =
    {
      draft: {
        label: t('status.draft'),
        cls: 'bg-muted text-foreground border-border',
        icon: <Icon.FileText className="h-3 w-3" />,
      },
      pending: {
        label: t('status.pending'),
        cls: 'bg-amber-50 text-amber-700 border-amber-200',
        icon: <Icon.Clock className="h-3 w-3" />,
      },
      approved: {
        label: t('status.approved'),
        cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        icon: <Icon.Check className="h-3 w-3" />,
      },
      rejected: {
        label: t('status.rejected'),
        cls: 'bg-red-50 text-red-700 border-red-200',
        icon: <Icon.Alert className="h-3 w-3" />,
      },
      paused: {
        label: t('status.paused'),
        cls: 'bg-orange-50 text-orange-700 border-orange-200',
        icon: <Icon.Pause className="h-3 w-3" />,
      },
      disabled: {
        label: t('status.disabled'),
        cls: 'bg-muted text-muted-ink border-border',
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
  const t = useT('whatsappIntegration.templates');
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
      if (tmplResp.error) throw new Error(tmplResp.error.message || t('toastFailedTitle'));
      if (tmplResp.data) setData(tmplResp.data);
      if (cfgResp.data) {
        setWbsConfig({
          wbsTemplateUseLogoHeader: Boolean(cfgResp.data.wbsTemplateUseLogoHeader),
          storeHasLogo: Boolean(cfgResp.data.storeHasLogo),
        });
      }
    } catch (err) {
      toastError(t('toastLoadFailedTitle'), err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [storeId, toastError, t]);

  const toggleLogoHeader = async (next: boolean) => {
    setSavingLogoToggle(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        wbsTemplateUseLogoHeader: next,
      });
      if (error) throw new Error(error.message || t('toastSaveFailedTitle'));
      setWbsConfig(c => (c ? { ...c, wbsTemplateUseLogoHeader: next } : c));
      toastSuccess(
        next ? t('toastLogoOnTitle') : t('toastLogoOffTitle'),
        next ? t('toastLogoOnBody') : t('toastLogoOffBody')
      );
    } catch (err) {
      toastError(t('toastSaveFailedTitle'), err instanceof Error ? err.message : String(err));
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
      if (error) throw new Error(error.message || t('toastGenFailedTitle'));
      const created = payload?.created ?? 0;
      toastSuccess(
        created > 0 ? t('toastCreatedTitle', { count: created }) : t('toastNoNewTitle'),
        payload?.message || (created > 0 ? t('toastCreatedBody') : t('toastAllSeededBody'))
      );
      await load();
    } catch (err) {
      toastError(t('toastGenFailedTitle'), err instanceof Error ? err.message : String(err));
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
      if (error) throw new Error(error.message || t('toastSyncFailedTitle'));
      const submitted = payload?.submitted ?? 0;
      toastSuccess(
        submitted > 0 ? t('toastSubmittedTitle', { count: submitted }) : t('toastNoDraftsTitle'),
        submitted > 0 ? t('toastSubmittedBody') : payload?.message || t('toastAllSubmittedBody')
      );
      await load();
    } catch (err) {
      toastError(t('toastSyncFailedTitle'), err instanceof Error ? err.message : String(err));
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
      if (error) throw new Error(error.message || t('toastResetFailedTitle'));
      const reset = payload?.reset ?? 0;
      toastSuccess(
        reset > 0 ? t('toastResetTitle', { count: reset }) : t('toastNoRejectedTitle'),
        payload?.message || (reset > 0 ? t('toastResetBody') : t('toastNoRejectedBody'))
      );
      await load();
    } catch (err) {
      toastError(t('toastResetFailedTitle'), err instanceof Error ? err.message : String(err));
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
          {generating ? t('generating') : hasAnyRows ? t('addMissing') : t('generateDefaults')}
        </Button>
        <Button
          onClick={sync}
          disabled={syncing || loading || draftCount === 0}
          variant={draftCount > 0 ? 'default' : 'outline'}
        >
          <Icon.Send className="me-2 h-4 w-4" />
          {syncing
            ? t('submitting')
            : draftCount > 0
              ? t('syncCount', { count: draftCount })
              : t('nothingToSync')}
        </Button>
        {rejectedCount > 0 && (
          <Button
            onClick={resetRejected}
            disabled={resetting || loading}
            variant="outline"
            title={t('resetRejectedHint')}
          >
            <Icon.Refresh className={`me-2 h-4 w-4 ${resetting ? 'animate-spin' : ''}`} />
            {resetting ? t('resetting') : t('resetRejectedCount', { count: rejectedCount })}
          </Button>
        )}
        <Button onClick={load} disabled={loading} variant="outline">
          <Icon.Refresh className={`me-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {t('refresh')}
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
              <div className="font-semibold text-sm text-foreground">{t('logoLabel')}</div>
              <p className="text-xs text-muted-foreground mt-0.5">{t('logoHint')}</p>
              {!wbsConfig.storeHasLogo && (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                  {t('logoNoLogoWarning')}
                </p>
              )}
              {wbsConfig.wbsTemplateUseLogoHeader && wbsConfig.storeHasLogo && (
                <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1">
                  {t('logoEnabledNote')}
                </p>
              )}
            </div>
          </label>
        </div>
      )}

      {/* Template list */}
      {loading && !data ? (
        <div className="rounded-md border bg-card p-8 text-center text-sm text-muted-foreground">
          {t('loading')}
        </div>
      ) : !hasAnyRows ? (
        <div className="rounded-md border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          <Icon.Sparkles className="mx-auto mb-2 h-8 w-8 text-orange-500" />
          <p className="font-medium text-foreground">{t('noTemplates')}</p>
          <p className="mt-1">{t('noTemplatesHint')}</p>
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
                      {t(`sourceKeys.${key}` as Parameters<typeof t>[0]) || key}
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
                            {t('metaRejected')} {row.rejectionReason}
                          </p>
                        )}
                        <p className="mt-1.5 text-[10.5px] text-muted-foreground font-mono">
                          {row.metaName}
                          {row.lastSyncedAt && (
                            <>
                              {' '}
                              · {t('lastSync')}{' '}
                              {new Date(row.lastSyncedAt).toLocaleString(undefined, withNumerals())}
                            </>
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
        {t('howItWorks')}
      </div>
    </div>
  );
}
