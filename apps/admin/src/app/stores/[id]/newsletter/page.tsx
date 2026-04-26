'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, getApiUrl } from '../../../../lib/api';

/**
 * Minimal admin viewer for newsletter subscribers.
 *
 * Lists subscribers captured by the storefront's footer signup form and
 * exposes a CSV export so admins can paste the list into their email
 * marketing tool of choice. Intentionally simple — no edit/delete/segment
 * UI — because the audit's main ask was "wire the customer-side form to
 * something the merchant can actually see."
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

export default function NewsletterPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const tPage = useT('newsletter.page');
  const tTable = useT('newsletter.table');

  const [subs, setSubs] = useState<Subscriber[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSubs = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await apiGet<SubscribersResponse>(
      `/api/v1/stores/${storeId}/newsletter/subscribers?limit=200`
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

  // CSV export hits a separate API endpoint that already streams the file
  // with the right Content-Type / Content-Disposition headers — we just
  // need to navigate the browser to that URL with credentials so the
  // auth cookie is sent.
  const handleExport = () => {
    const url = `${getApiUrl()}/api/v1/stores/${storeId}/newsletter/subscribers/export`;
    window.open(url, '_blank');
  };

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <Button type="button" onClick={handleExport} disabled={subs.length === 0}>
          {tPage('exportCsv')}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{tPage('totalCount', { count: total })}</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
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
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-4 py-3 font-medium">{tTable('email')}</th>
                  <th className="px-4 py-3 font-medium">{tTable('language')}</th>
                  <th className="px-4 py-3 font-medium">{tTable('source')}</th>
                  <th className="px-4 py-3 font-medium">{tTable('status')}</th>
                  <th className="px-4 py-3 font-medium">{tTable('subscribedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {subs.map(s => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="px-4 py-3 font-mono text-xs">{s.email}</td>
                    <td className="px-4 py-3">{s.language || '—'}</td>
                    <td className="px-4 py-3">{s.source || '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          s.isActive
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {s.isActive ? tTable('active') : tTable('unsubscribed')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(s.subscribedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
