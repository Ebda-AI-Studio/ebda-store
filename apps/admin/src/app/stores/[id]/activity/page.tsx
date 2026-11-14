'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { intlLocaleForUi } from '@/lib/format';

interface ActivityItem {
  id: string;
  at: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actor: { name: string; role: string } | null;
  ip: string | null;
  details: Record<string, string | number | boolean | null>;
}
interface Page {
  items: ActivityItem[];
  nextCursor: string | null;
}

/** Store activity log (A24, team.audit-log): read-only, newest first, owner / store_admin only. The API masks every contact field. */
export default function StoreActivityPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const { user } = useAuth();
  const t = useT('activity');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (user && user.role !== 'store_admin' && user.role !== 'super_admin') {
      router.replace(`/stores/${storeId}`);
    }
  }, [user, storeId, router]);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setError(false);
      const q = after ? `?cursor=${encodeURIComponent(after)}` : '';
      const { data, error: err } = await apiGet<Page>(`/api/v1/stores/${storeId}/activity${q}`);
      if (err || !data) setError(true);
      else {
        setItems(prev => (after ? [...prev, ...data.items] : data.items));
        setCursor(data.nextCursor);
      }
      setLoading(false);
    },
    [storeId]
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  const when = (iso: string) =>
    new Date(iso).toLocaleString(intlLocaleForUi(), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {error && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive-ink"
        >
          {t('error')}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm" aria-label={t('tableLabel')}>
            <thead className="text-start text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-start font-medium">{t('colWhen')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('colWho')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('colWhat')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('colNetwork')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(i => (
                <tr key={i.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-4 py-3">{when(i.at)}</td>
                  <td className="px-4 py-3">{i.actor?.name || t('system')}</td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs" dir="ltr">
                      {i.action}
                    </span>
                    <span className="ms-2 text-muted-foreground">{i.resourceType}</span>
                    {Object.keys(i.details).length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                        {Object.entries(i.details)
                          .map(([k, v]) => `${k}: ${String(v)}`)
                          .join(' · ')}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" dir="ltr">
                    {i.ip ?? '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <Button
          className="mt-4"
          variant="outline"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          {loading ? t('loading') : t('loadMore')}
        </Button>
      )}
    </AdminLayout>
  );
}
