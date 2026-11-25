'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { LEGAL_DOC_TITLE, isLegalDocKey } from '@ebda/shared';
import { apiGet } from '../../lib/api';
import { useT } from '../../i18n/useT';

/**
 * Legal acceptance records (Ruling LEGAL-4, final review I6: "every data has a UI").
 *
 *  - `userId` given: the super-admin user page. Reads GET /admin/users/:id/legal-acceptances:
 *    every acceptance (document, version, how, when, masked IP) plus the notice emails sent to
 *    that account. This is the dispute evidence ("I never agreed") without SQL.
 *  - no `userId`: the signed-in merchant's own "Policies you accepted" (account settings),
 *    read-only, from GET /me/legal-acceptances. No IP shown.
 *
 * Times are UTC with Latin digits (NUMERALS-1).
 */
interface Acceptance {
  docKey: string;
  version: string;
  source: string;
  acceptedAt: string;
  maskedIp?: string | null;
}
interface Delivery {
  docKey: string;
  version: string;
  status: string;
  error: string | null;
  at: string;
}

/** "2026-10-21 10:05" (LTR-isolated where it is interpolated into Arabic copy). */
// No line break inside the stamp: non-breaking space, word joiners around the date hyphens.
const utcStamp = (iso: string) =>
  iso.slice(0, 16).replace('T', '\u00a0').replace(/-/g, '\u2060-\u2060');
const KNOWN_SOURCES = ['signup', 'notice_ack'];
const KNOWN_STATUSES = ['queued', 'sending', 'sent', 'failed'];

export function LegalAcceptancesPanel({ userId }: { userId?: string }) {
  const t = useT('legalAcceptances');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [rows, setRows] = useState<Acceptance[] | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const url = userId
      ? `/api/v1/admin/users/${encodeURIComponent(userId)}/legal-acceptances`
      : '/api/v1/me/legal-acceptances';
    void apiGet<{ acceptances: Acceptance[]; deliveries?: Delivery[] }>(url).then(
      ({ data, error }) => {
        if (cancelled) return;
        setFailed(!!error);
        setRows(data?.acceptances ?? []);
        setDeliveries(data?.deliveries ?? []);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const title = (docKey: string) =>
    isLegalDocKey(docKey) ? LEGAL_DOC_TITLE[docKey][locale] : docKey;
  const time = (iso: string) => (
    <span className="tabular-nums">{t('at', { time: `\u2066${utcStamp(iso)}\u2069` })}</span>
  );

  return (
    <section className="rounded-md border bg-card shadow-sm" aria-labelledby="legal-acceptances">
      <div className="border-b p-4">
        <h2 id="legal-acceptances" className="font-semibold text-foreground">
          {userId ? t('adminTitle') : t('mineTitle')}
        </h2>
        {!userId && <p className="mt-0.5 text-sm text-muted-foreground">{t('mineHint')}</p>}
      </div>
      <div className="p-4 text-sm">
        {rows === null ? (
          <p className="text-muted-foreground">{t('loading')}</p>
        ) : failed ? (
          <p role="alert" className="text-destructive-ink">
            {t('loadFailed')}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y">
            {rows.map(a => (
              <li key={`${a.docKey}@${a.version}`} className="py-2 first:pt-0 last:pb-0">
                <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium text-foreground">{title(a.docKey)}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('version', { version: a.version })}
                  </span>
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>
                    {KNOWN_SOURCES.includes(a.source) ? t(`source.${a.source}`) : a.source}
                  </span>
                  {time(a.acceptedAt)}
                  {userId && a.maskedIp && (
                    <span>{t('ip', { ip: `\u2066${a.maskedIp}\u2069` })}</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        {userId && deliveries.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <h3 className="text-sm font-medium text-foreground">{t('deliveriesTitle')}</h3>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {deliveries.map(d => (
                <li key={`${d.docKey}@${d.version}`} className="flex flex-wrap gap-x-3 break-words">
                  <span className="text-foreground">
                    {title(d.docKey)} · {t('version', { version: d.version })}
                  </span>
                  <span>
                    {KNOWN_STATUSES.includes(d.status) ? t(`status.${d.status}`) : d.status}
                  </span>
                  {d.error && <span dir="ltr">{d.error}</span>}
                  {time(d.at)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
