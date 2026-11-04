'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { formatLegalDate, type PendingLegalNotice } from '@ebda/shared';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';

/**
 * Material policy-change notice (Ruling LEGAL-4). Shown on every store page, next to the
 * billing banner, while the signed-in merchant has a sent, unacknowledged material version.
 * Non-blocking: the page works underneath it. One "Got it" acknowledges every listed notice.
 * Notices are per USER, so acknowledging in one store clears it in all of them; `storeId`
 * only re-triggers the read when the merchant switches store.
 *
 * Read errors (incl. the 403 an impersonating super admin gets) render nothing: the banner is
 * a courtesy, never an error surface. A failed acknowledgement (e.g. 422 NOT_PENDING after a
 * version changed) re-reads the list so the banner never shows a stale notice, and says so.
 */
export function LegalNoticeBanner({ storeId }: { storeId: string }) {
  const t = useT('legalNotice');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [notices, setNotices] = useState<PendingLegalNotice[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const { data } = await apiGet<{ notices: PendingLegalNotice[] }>('/api/v1/me/legal-notices');
    return data?.notices ?? null;
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void load().then(list => {
      if (!cancelled) setNotices(list ?? []);
    });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [storeId, load]);

  const acknowledge = async () => {
    setSaving(true);
    setFailed(false);
    const { error } = await apiPost<{ acknowledged: number }>('/api/v1/me/legal-notices/ack', {
      items: notices.map(n => ({ docKey: n.docKey, version: n.version })),
    });
    if (!error) {
      setSaving(false);
      setNotices([]);
      // The button that had focus is unmounting; hand focus to the page, not <body>.
      document.getElementById('admin-main-content')?.focus({ preventScroll: true });
      return;
    }
    const fresh = await load();
    if (!alive.current) return;
    setSaving(false);
    if (fresh) setNotices(fresh);
    // Nothing left pending after the re-read (acked elsewhere): the banner goes, no error.
    setFailed(fresh === null || fresh.length > 0);
  };

  if (notices.length === 0) return null;

  return (
    <div
      role="status"
      aria-labelledby="legal-notice-title"
      className="flex flex-col gap-2 border-b border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-ink lg:ms-72"
    >
      <p id="legal-notice-title" className="font-medium">
        {t('title')}
      </p>
      <ul className="space-y-1">
        {notices.map(n => (
          <li key={`${n.docKey}@${n.version}`}>
            <span className="font-medium">{n.title[locale]}</span>
            {': '}
            {n.summary[locale]} {t('effective', { date: formatLegalDate(n.effectiveAt, locale) })}{' '}
            <a
              href={n.url[locale]}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              aria-label={t('readAria', { title: n.title[locale] })}
            >
              {t('read')}
            </a>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={acknowledge}
          disabled={saving}
          className="min-h-9 rounded-md bg-warning-ink px-3 py-1.5 text-xs font-medium text-background disabled:opacity-60"
        >
          {saving ? t('saving') : t('gotIt')}
        </button>
        {failed && <span role="alert">{t('ackFailed')}</span>}
      </div>
    </div>
  );
}
