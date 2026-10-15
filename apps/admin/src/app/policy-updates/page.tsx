'use client';

/**
 * Super-admin Policy updates - /policy-updates (Ruling LEGAL-4).
 *
 * Each legal document's current version (from LEGAL_POLICIES via the API). A material version
 * with no notice yet gets "Send notice": an in-page confirmation (no window.confirm), then ONE
 * POST that emails every store owner and turns on the dashboard banner. Delivery and
 * acknowledgement counts show what happened.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's MFA + super_admin chain).
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@ebda/ui';
import { formatLegalDate, type LegalDocKey, type LegalVersion } from '@ebda/shared';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';

interface PolicyRow {
  docKey: LegalDocKey;
  title: { ar: string; en: string };
  current: LegalVersion;
  send: { sentAt: string; sentBy: string; recipientCount: number | null } | null;
  deliveries: { queued: number; sending: number; sent: number; failed: number };
  failedDeliveries?: Array<{ maskedEmail: string; error: string | null; at: string }>;
  acceptedCount: number;
  canSend: boolean;
}

function PolicyUpdatesInner() {
  const t = useT('policyUpdates');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [rows, setRows] = useState<PolicyRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState<LegalDocKey | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await apiGet<{ policies: PolicyRow[] }>('/api/v1/admin/legal-policies');
    setLoadError(!!error);
    setRows(data?.policies ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (row: PolicyRow) => {
    setSending(true);
    setMessage(null);
    const { error } = await apiPost(
      `/api/v1/admin/legal-policies/${row.docKey}/${encodeURIComponent(row.current.version)}/send-notice`,
      {}
    );
    setSending(false);
    setConfirming(null);
    setMessage(
      !error
        ? t('sendStarted')
        : error.status === 409
          ? t('alreadySent')
          : error.code === 'WITHDRAW_FAILED'
            ? t('sendUncertain')
            : t('sendFailed')
    );
    await load();
  };

  if (rows === null) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  if (loadError) {
    return (
      <p role="alert" className="text-sm text-destructive-ink">
        {t('loadFailed')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <ul className="space-y-3">
        {rows.map(row => (
          <li key={row.docKey} className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium">{row.title[locale]}</h2>
              <span className="text-xs text-muted-foreground">
                {t('version', { version: row.current.version })}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('published', { date: formatLegalDate(row.current.publishedAt, locale) })}{' '}
              {t('effective', { date: formatLegalDate(row.current.effectiveAt, locale) })}
            </p>
            <p className="mt-1 text-sm">{row.current.summary[locale]}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.current.material ? t('material') : t('notMaterial')}
              {row.current.feeChange ? ` ${t('feeChange')}` : ''}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('accepted', { n: String(row.acceptedCount) })}
            </p>
            {row.send && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('sentAt', { date: formatLegalDate(row.send.sentAt.slice(0, 10), locale) })}{' '}
                {t('deliveries', {
                  total: String(row.send.recipientCount ?? 0),
                  sent: String(row.deliveries.sent),
                  failed: String(row.deliveries.failed),
                  queued: String(row.deliveries.queued),
                })}
              </p>
            )}
            {row.send && row.send.recipientCount === null && (
              <p className="mt-1 text-xs text-destructive-ink">{t('noRun')}</p>
            )}
            {row.send && row.deliveries.sending > 0 && (
              <p className="mt-1 text-xs text-destructive-ink">
                {t('stuck', { n: String(row.deliveries.sending) })}
              </p>
            )}
            {row.send && (row.failedDeliveries?.length ?? 0) > 0 && (
              <div className="mt-2">
                <h3 className="text-sm font-medium">{t('failedTitle')}</h3>
                {row.deliveries.failed > (row.failedDeliveries?.length ?? 0) && (
                  <p className="text-xs text-muted-foreground">
                    {t('failedMore', {
                      shown: String(row.failedDeliveries?.length ?? 0),
                      total: String(row.deliveries.failed),
                    })}
                  </p>
                )}
                <ul className="mt-1 space-y-1 text-xs">
                  {row.failedDeliveries?.map((f, i) => (
                    <li key={`${f.maskedEmail}-${i}`}>
                      {t('failedRow', {
                        email: `\u2066${f.maskedEmail}\u2069`,
                        reason: f.error ?? '-',
                        time: `${f.at.slice(0, 16).replace('T', ' ')} UTC`,
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {row.canSend && confirming !== row.docKey && (
              <div className="mt-3">
                <Button onClick={() => setConfirming(row.docKey)}>{t('sendNotice')}</Button>
              </div>
            )}
            {confirming === row.docKey && (
              <div className="mt-3 space-y-2 rounded-md bg-muted p-3 text-sm">
                <p className="font-medium">{t('confirmTitle')}</p>
                <p>{t('confirmBody')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => send(row)} disabled={sending}>
                    {sending ? t('sending') : t('confirmSend')}
                  </Button>
                  <Button onClick={() => setConfirming(null)} disabled={sending}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PolicyUpdatesPage() {
  const t = useT('policyUpdates');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <PolicyUpdatesInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
