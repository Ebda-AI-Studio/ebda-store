'use client';

/**
 * Super-admin Policy updates - /policy-updates (Ruling LEGAL-4).
 *
 * Each legal document's current version (from LEGAL_POLICIES via the API). A material version
 * with no notice yet gets "Send notice": an in-page confirmation (no window.confirm), then ONE
 * POST that emails every store owner and turns on the dashboard banner. Delivery and
 * acknowledgement counts show what happened.
 *
 * Run states (I4): the API decides what is unhealthy (aged rows only), the page never guesses
 * from raw counts: `noRun` (no recipients 10 min after Send), `stalled` (nothing moved for
 * 15 min), `stuckSending` (claimed 15+ min ago, never finishes). A run that is merely in flight
 * reads as neutral "sending". Recovery (I5): "Resume" when stalled, "Retry failed" when any
 * email failed; both confirm in the page and are safe to press (nobody is mailed twice).
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's MFA + super_admin chain).
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
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
  stuckSending?: number;
  noRun?: boolean;
  stalled?: boolean;
  failedDeliveries?: Array<{ maskedEmail: string; error: string | null; at: string }>;
  /** TIMEOUT_UNKNOWN rows: the mail may have been delivered; never retried by the page. */
  unknownOutcome?: number;
  unknownDeliveries?: Array<{ maskedEmail: string; error: string | null; at: string }>;
  acceptedCount: number;
  canSend: boolean;
  sendBlocked?: 'NOTICE_TOO_LATE' | null;
}

type Action = 'send' | 'resume' | 'retry';

/** "2026-10-21 10:05": Latin digits, UTC (the "UTC" label lives in the i18n message). */
// No line break inside the stamp: non-breaking space, word joiners around the date hyphens.
const utcStamp = (iso: string) =>
  iso.slice(0, 16).replace('T', '\u00a0').replace(/-/g, '\u2060-\u2060');

function PolicyUpdatesInner() {
  const t = useT('policyUpdates');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [rows, setRows] = useState<PolicyRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState<{ docKey: LegalDocKey; action: Action } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await apiGet<{ policies: PolicyRow[] }>('/api/v1/admin/legal-policies');
    setLoadError(!!error);
    setRows(data?.policies ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (row: PolicyRow, action: Action) => {
    setBusy(true);
    setMessage(null);
    const path = { send: 'send-notice', resume: 'resume', retry: 'retry-failed' }[action];
    const { data, error } = await apiPost<{ requeued?: number }>(
      `/api/v1/admin/legal-policies/${row.docKey}/${encodeURIComponent(row.current.version)}/${path}`,
      {}
    );
    setBusy(false);
    setConfirming(null);
    if (error) {
      setMessage(
        error.code === 'NOTICE_TOO_LATE'
          ? t('tooLate')
          : error.code === 'NOT_CURRENT'
            ? t('notCurrent')
            : action !== 'send'
              ? t('actionFailed')
              : error.status === 409
                ? t('alreadySent')
                : error.code === 'WITHDRAW_FAILED'
                  ? t('sendUncertain')
                  : t('sendFailed')
      );
    } else if (action === 'send') {
      setMessage(t('sendStarted'));
    } else if (action === 'resume') {
      setMessage(t('resumeStarted'));
    } else {
      const n = data?.requeued ?? 0;
      setMessage(n > 0 ? t('retryStarted', { n: String(n) }) : t('retryNone'));
    }
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

  const confirmCopy: Record<Action, { title: string; body: string; yes: string }> = {
    send: { title: t('confirmTitle'), body: t('confirmBody'), yes: t('confirmSend') },
    resume: { title: t('resumeTitle'), body: t('resumeBody'), yes: t('resumeConfirm') },
    retry: { title: t('retryTitle'), body: t('retryBody'), yes: t('retryConfirm') },
  };

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="policy-howto-title"
        className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
      >
        <h2 id="policy-howto-title" className="font-medium">
          {t('howToTitle')}
        </h2>
        <p className="mt-1 text-muted-foreground">{t('howToIntro')}</p>
        <ol className="mt-2 list-decimal space-y-1 ps-5 text-muted-foreground">
          <li>{t('howToStep1')}</li>
          <li>{t('howToStep2')}</li>
          <li>{t('howToStep3')}</li>
        </ol>
        <p className="mt-2 text-muted-foreground">{t('howToNotMaterial')}</p>
      </section>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <ul className="space-y-3">
        {rows.map(row => {
          const d = row.deliveries;
          const stuck = row.stuckSending ?? 0;
          const inFlight =
            !!row.send &&
            !row.stalled &&
            (row.send.recipientCount === null || d.queued > 0 || d.sending > stuck);
          const open = confirming?.docKey === row.docKey ? confirming.action : null;
          const copy = open ? confirmCopy[open] : null;
          return (
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
                {row.current.feeChange ? ` ${t('feeChange')}` : ''}{' '}
                {t('accepted', { n: String(row.acceptedCount) })}
              </p>
              {row.sendBlocked === 'NOTICE_TOO_LATE' && (
                <p className="mt-2 text-xs text-destructive-ink">{t('tooLate')}</p>
              )}
              {row.send && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('sentAt', { date: formatLegalDate(row.send.sentAt.slice(0, 10), locale) })}{' '}
                  {row.send.recipientCount !== null &&
                    t('deliveries', {
                      total: String(row.send.recipientCount),
                      sent: String(d.sent),
                      failed: String(d.failed),
                      queued: String(d.queued),
                    })}
                </p>
              )}
              {inFlight && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {row.send!.recipientCount === null
                    ? t('starting')
                    : t('inProgress', { n: String(d.queued + d.sending - stuck) })}
                </p>
              )}
              {row.noRun && <p className="mt-1 text-xs text-destructive-ink">{t('noRun')}</p>}
              {row.stalled && !row.noRun && (
                <p className="mt-1 text-xs text-destructive-ink">
                  {t('stalled', { n: String(d.queued) })}
                </p>
              )}
              {stuck > 0 && (
                <p className="mt-1 text-xs text-destructive-ink">
                  {t('stuck', { n: String(stuck) })}
                </p>
              )}
              {row.send && (row.failedDeliveries?.length ?? 0) > 0 && (
                <div className="mt-2">
                  <h3 className="text-sm font-medium">{t('failedTitle')}</h3>
                  {d.failed > (row.failedDeliveries?.length ?? 0) && (
                    <p className="text-xs text-muted-foreground">
                      {t('failedMore', {
                        shown: String(row.failedDeliveries?.length ?? 0),
                        total: String(d.failed),
                      })}
                    </p>
                  )}
                  <ul className="mt-1 space-y-1 text-xs">
                    {row.failedDeliveries?.map((f, i) => (
                      <li key={`${f.maskedEmail}-${i}`} className="break-words">
                        {t('failedRow', {
                          email: `⁦${f.maskedEmail}⁩`,
                          // First-strong isolate: provider text is usually Latin inside Arabic copy.
                          reason: `\u2068${f.error ?? '-'}\u2069`,
                          time: utcStamp(f.at),
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {row.send && (row.unknownDeliveries?.length ?? 0) > 0 && (
                <div className="mt-2" data-testid="unknown-outcome">
                  <h3 className="text-sm font-medium">{t('unknownTitle')}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t('unknownHint', { n: String(row.unknownOutcome ?? 0) })}
                  </p>
                  <ul className="mt-1 space-y-1 text-xs">
                    {row.unknownDeliveries?.map((f, i) => (
                      <li key={`${f.maskedEmail}-${i}`} className="break-words">
                        {t('unknownRow', {
                          email: `\u2066${f.maskedEmail}\u2069`,
                          time: utcStamp(f.at),
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!open && (row.canSend || row.stalled || (row.send && d.failed > 0)) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {row.canSend && (
                    <Button onClick={() => setConfirming({ docKey: row.docKey, action: 'send' })}>
                      {t('sendNotice')}
                    </Button>
                  )}
                  {row.send && row.stalled && (
                    <Button
                      variant="outline"
                      onClick={() => setConfirming({ docKey: row.docKey, action: 'resume' })}
                    >
                      {t('resume')}
                    </Button>
                  )}
                  {row.send && d.failed > 0 && (
                    <Button
                      variant="outline"
                      onClick={() => setConfirming({ docKey: row.docKey, action: 'retry' })}
                    >
                      {t('retryFailed', { n: String(d.failed) })}
                    </Button>
                  )}
                </div>
              )}
              {open && copy && (
                <div className="mt-3 space-y-2 rounded-md bg-muted p-3 text-sm">
                  <p className="font-medium">{copy.title}</p>
                  <p>{copy.body}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => run(row, open)} disabled={busy}>
                      {busy ? t('sending') : copy.yes}
                    </Button>
                    <Button variant="outline" onClick={() => setConfirming(null)} disabled={busy}>
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
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
