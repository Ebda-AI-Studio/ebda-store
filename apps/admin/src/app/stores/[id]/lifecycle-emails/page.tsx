'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { OrderStatusBadge } from '@/components/OrderStatusBadge';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '../../../../components/ErrorState';
import { useToast } from '@ebda/ui';
import { apiGet, apiPost } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/format';

type Status = 'sent' | 'skipped' | 'failed' | 'pending';
interface Entry {
  kind: string;
  status: Status;
  reason: string | null;
  at: string | null;
}
interface Log {
  optedOut: boolean;
  entries: Entry[];
}

/** The merchant's view of the self-serve lifecycle emails Ebda sent (and why some were not needed). */
export default function LifecycleEmailsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('lifecycleEmails');
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [sending, setSending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { data, error: apiError } = await apiGet<Log>(
      `/api/v1/stores/${storeId}/lifecycle-emails`
    );
    if (apiError) setError(apiError.message ?? '');
    else if (data) setLog(data);
  }, [storeId]);

  /** Owner-only: mail this one message to the owner's own address (never a customer), to see it and check the unsubscribe header. */
  const sendTest = async (kind: string) => {
    setSending(kind);
    const { data, error: apiError } = await apiPost<{ to: string }>(
      `/api/v1/stores/${storeId}/lifecycle-emails/test-send`,
      { kind }
    );
    setSending(null);
    if (apiError) toast.error(apiError.message || t('testSendFailed'));
    else toast.success(t('testSent', { to: data?.to ?? '' }));
  };

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {error !== null ? (
        <ErrorState message={error || t('loadFailed')} onRetry={load} />
      ) : !log ? (
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
        </div>
      ) : (
        <div className="space-y-4">
          {log.optedOut && (
            <p className="rounded-md border border-border bg-card p-4 text-sm">{t('optedOut')}</p>
          )}
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-start text-muted-foreground">
                  <th className="p-3 text-start font-medium">{t('colEmail')}</th>
                  <th className="p-3 text-start font-medium">{t('colStatus')}</th>
                  <th className="p-3 text-start font-medium">{t('colWhen')}</th>
                  <th className="p-3 text-start font-medium">{t('colNote')}</th>
                  <th className="p-3 text-start font-medium">{t('colTest')}</th>
                </tr>
              </thead>
              <tbody>
                {log.entries.map(e => (
                  <tr key={e.kind} className="border-b border-border last:border-0">
                    <td className="p-3">{t(`kind.${e.kind}`)}</td>
                    <td className="p-3">
                      <OrderStatusBadge family="lifecycleEmail" status={e.status} />
                    </td>
                    <td className="p-3 whitespace-nowrap">{e.at ? formatDateTime(e.at) : '-'}</td>
                    <td className="p-3 text-muted-foreground">
                      {e.reason ? t(`reason.${e.reason}`) : ''}
                    </td>
                    <td className="p-3">
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={() => void sendTest(e.kind)}
                        disabled={sending !== null}
                      >
                        {sending === e.kind ? t('testSending') : t('testSend')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
