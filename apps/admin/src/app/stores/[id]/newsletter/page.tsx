'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, getApiUrl, apiFetch, apiPost } from '../../../../lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { withNumerals } from '@ebda/shared';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';

/**
 * Admin newsletter page.
 *
 * Lists subscribers and exposes CSV/XLSX exports so admins can feed their
 * email marketing tool. Also includes a simple broadcast composer so
 * admins can send a one-off newsletter directly from the platform via the
 * store's configured Resend sender.
 */

interface Subscriber {
  id: string;
  email: string;
  language: string | null;
  source: string | null;
  isActive: boolean;
  subscribedAt: string;
  unsubscribedAt: string | null;
}

interface SubscribersResponse {
  subscribers: Subscriber[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface BroadcastResult {
  sent: number;
  total: number;
  errors?: string[];
}

// Max subscribers fetched into the table view. The full count is always shown
// from `pagination.total`; when it exceeds this cap a notice tells the merchant
// the table is partial (and to use export for the complete list).
const SUBSCRIBER_FETCH_LIMIT = 200;

export default function NewsletterPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const tPage = useT('newsletter.page');
  const tTable = useT('newsletter.table');

  const [subs, setSubs] = useState<Subscriber[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Broadcast form state
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [broadcastSending, setBroadcastSending] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<BroadcastResult | null>(null);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);

  // Heuristic warning for content the server-side sanitizer will strip before
  // sending. Mirrors the API allowlist so merchants get feedback before they
  // hit Send (the API is still the authoritative guard).
  const hasRiskyHtml =
    /<\s*(script|iframe|object|embed|form)\b/i.test(html) ||
    /\son[a-z-]+\s*=/i.test(html) ||
    /(href|src)\s*=\s*["']?\s*(javascript|vbscript|data:(?!image\/))/i.test(html);

  const fetchSubs = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await apiGet<SubscribersResponse>(
      `/api/v1/stores/${storeId}/newsletter/subscribers?limit=${SUBSCRIBER_FETCH_LIMIT}`
    );
    if (err) {
      setError(err.message || 'Failed to load subscribers');
    } else if (data) {
      setSubs(data.subscribers);
      setTotal(data.pagination.total);
    }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    if (storeId) fetchSubs();
  }, [storeId, fetchSubs]);

  // CSV export — navigates to the endpoint so the browser downloads directly.
  const handleExportCsv = () => {
    const url = `${getApiUrl()}/api/v1/stores/${storeId}/newsletter/subscribers/export`;
    window.open(url, '_blank');
  };

  // XLSX export — fetches with credentials then triggers a blob download.
  const handleExportXlsx = async () => {
    try {
      const response = await apiFetch(
        `/api/v1/stores/${storeId}/newsletter/subscribers/export.xlsx`
      );
      if (!response.ok) return;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `newsletter-${storeId}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // silently ignore — user can retry
    }
  };

  const openBroadcast = () => {
    setShowBroadcast(true);
    setBroadcastResult(null);
    setBroadcastError(null);
    setTimeout(() => subjectRef.current?.focus(), 50);
  };

  const closeBroadcast = () => {
    setShowBroadcast(false);
    setSubject('');
    setHtml('');
    setBroadcastResult(null);
    setBroadcastError(null);
  };

  const handleSendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !html.trim()) return;

    setBroadcastSending(true);
    setBroadcastError(null);
    setBroadcastResult(null);

    const { data, error: err } = await apiPost<BroadcastResult>(
      `/api/v1/stores/${storeId}/newsletter/broadcast`,
      { subject: subject.trim(), html: html.trim() }
    );

    setBroadcastSending(false);

    if (err) {
      setBroadcastError(err.message || 'Failed to send broadcast');
    } else if (data) {
      setBroadcastResult(data);
    }
  };

  const columns: DataTableColumn<Subscriber>[] = [
    {
      header: tTable('email'),
      primaryOnMobile: true,
      cell: s => <span className="font-mono text-xs">{s.email}</span>,
    },
    {
      header: tTable('language'),
      cell: s => <>{s.language || '—'}</>,
    },
    {
      header: tTable('source'),
      cell: s => <>{s.source || '—'}</>,
    },
    {
      header: tTable('status'),
      mobileBadge: true,
      cell: s => (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            s.isActive ? 'bg-success/10 text-success-ink' : 'bg-muted text-muted-foreground'
          }`}
        >
          {s.isActive ? tTable('active') : tTable('unsubscribed')}
        </span>
      ),
    },
    {
      header: tTable('subscribedAt'),
      cell: s => (
        <span className="text-muted-foreground">
          {new Date(s.subscribedAt).toLocaleDateString(undefined, withNumerals())}
        </span>
      ),
    },
  ];

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={subs.length === 0}
          >
            {tPage('exportCsv')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExportXlsx}
            disabled={subs.length === 0}
          >
            {tPage('exportXlsx')}
          </Button>
          <Button type="button" size="sm" onClick={openBroadcast} disabled={subs.length === 0}>
            {tPage('sendBroadcast')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{tPage('totalCount', { count: total })}</p>
        </div>

        {/* Truncation notice — the table is capped; the full count above is
            accurate, but rows beyond the cap are only available via export. */}
        {total > subs.length && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning-ink">
            {tPage('truncatedNotice', { shown: subs.length, total })}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive-ink">
            {error}
          </div>
        ) : subs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-foreground font-medium">{tPage('emptyTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground max-w-md">
              {tPage('emptyDescription')}
            </p>
          </div>
        ) : (
          <DataTable<Subscriber>
            ariaLabel={tPage('title')}
            columns={columns}
            rows={subs}
            rowKey={s => s.id}
          />
        )}
      </div>

      {/* Broadcast Modal */}
      {showBroadcast && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-background shadow-xl border border-border">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h2 className="text-lg font-semibold">{tPage('broadcastTitle')}</h2>
                <p className="text-sm text-muted-foreground">
                  {tPage('broadcastSubtitle', { count: subs.filter(s => s.isActive).length })}
                </p>
              </div>
              <button
                type="button"
                onClick={closeBroadcast}
                className="text-muted-foreground hover:text-foreground"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {broadcastResult ? (
              <div className="px-6 py-8 text-center">
                <div className="w-14 h-14 bg-success/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg
                    className="w-7 h-7 text-success-ink"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold mb-1">{tPage('broadcastSent')}</h3>
                <p className="text-muted-foreground text-sm">
                  {tPage('broadcastSentCount', {
                    sent: broadcastResult.sent,
                    total: broadcastResult.total,
                  })}
                </p>
                {broadcastResult.errors && broadcastResult.errors.length > 0 && (
                  <p className="mt-2 text-xs text-destructive-ink">
                    {tPage('chunksFailed', { count: broadcastResult.errors.length })}
                  </p>
                )}
                <Button type="button" variant="outline" onClick={closeBroadcast} className="mt-6">
                  {tPage('broadcastClose')}
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSendBroadcast} className="px-6 py-5 space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    {tPage('broadcastSubjectLabel')}
                  </label>
                  <input
                    ref={subjectRef}
                    type="text"
                    value={subject}
                    onChange={e => setSubject(e.target.value)}
                    required
                    maxLength={300}
                    placeholder={tPage('broadcastSubjectPlaceholder')}
                    className={FIELD_CLASSES}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    {tPage('broadcastBodyLabel')}
                  </label>
                  <p className="text-xs text-muted-foreground mb-2">{tPage('broadcastBodyHint')}</p>
                  <textarea
                    value={html}
                    onChange={e => setHtml(e.target.value)}
                    required
                    rows={10}
                    placeholder={tPage('broadcastBodyPlaceholder')}
                    className={`${TEXTAREA_CLASSES} font-mono resize-y`}
                  />

                  {hasRiskyHtml && (
                    <div className="mt-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-xs text-warning-ink">
                      {tPage('broadcastUnsafeWarning')}
                    </div>
                  )}

                  {html.trim() && (
                    <div className="mt-3">
                      <Button
                        variant="link"
                        size="sm"
                        type="button"
                        onClick={() => setShowPreview(p => !p)}
                      >
                        {showPreview
                          ? tPage('broadcastPreviewHide')
                          : tPage('broadcastPreviewShow')}
                      </Button>
                      {showPreview && (
                        <div className="mt-2 rounded-lg border border-border overflow-hidden bg-white">
                          {/* sandbox="" blocks script execution + same-origin
                              access, so the preview can render merchant HTML
                              without any XSS risk to the admin app. */}
                          <iframe
                            title={tPage('broadcastPreviewTitle')}
                            sandbox=""
                            srcDoc={html}
                            className="w-full h-72 border-0"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {broadcastError && (
                  <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive-ink">
                    {broadcastError}
                  </div>
                )}

                <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeBroadcast}
                    disabled={broadcastSending}
                  >
                    {tPage('broadcastCancel')}
                  </Button>
                  <Button
                    type="submit"
                    disabled={broadcastSending || !subject.trim() || !html.trim()}
                  >
                    {broadcastSending ? tPage('broadcastSending') : tPage('broadcastSend')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
