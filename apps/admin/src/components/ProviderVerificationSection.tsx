'use client';

/**
 * Super admin: what real traffic has proven about each provider (Ruling PROVIDERS-3). A provider
 * flips to verified by itself after N successful real operations; the recent evidence (store, op,
 * outcome, reference, error code) is listed so a failure is traceable. No credential is shown.
 */
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { PROVIDER_CATALOG, withNumerals } from '@ebda/shared';
import { apiGet } from '../lib/api';
import { useT } from '../i18n/useT';

interface Row {
  provider: string;
  kind: string;
  catalogVerified: boolean;
  successCount: number;
  failureCount: number;
  verifiedAt: string | null;
  needed: number;
  recent: Array<{
    storeId: string;
    op: string;
    ok: boolean;
    ref: string | null;
    errorCode: string | null;
    at: string;
  }>;
}

export function ProviderVerificationSection() {
  const t = useT('providerVerification');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    apiGet<{ providers: Row[] }>('/api/v1/admin/provider-verification').then(({ data, error }) => {
      if (!live) return;
      setFailed(Boolean(error));
      setRows(data?.providers ?? []);
    });
    return () => {
      live = false;
    };
  }, []);

  const name = (code: string) => PROVIDER_CATALOG.find(p => p.code === code)?.name[locale] ?? code;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-GB', withNumerals());

  return (
    <section className="mb-8 space-y-3" data-testid="provider-verification">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {failed && <p className="text-sm text-destructive-ink">{t('loadFailed')}</p>}
      {rows === null && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
      <div className="space-y-2">
        {(rows ?? []).map(r => {
          const verified = r.catalogVerified || r.verifiedAt !== null;
          return (
            <details key={r.provider} className="rounded-lg border bg-card p-3">
              <summary className="flex cursor-pointer flex-wrap items-center gap-3">
                <span className="font-medium">{name(r.provider)}</span>
                <Badge variant={verified ? 'success' : 'warning'}>
                  {verified
                    ? r.catalogVerified
                      ? t('verifiedCatalog')
                      : t('verifiedAuto', { at: fmt(r.verifiedAt!) })
                    : t('unverified')}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {t('counts', {
                    ok: r.successCount,
                    failed: r.failureCount,
                    needed: r.needed,
                  })}
                </span>
              </summary>
              {r.recent.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">{t('noEvidence')}</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {r.recent.map((e, i) => (
                    <li key={`${e.at}-${i}`} className="flex flex-wrap gap-x-3">
                      <span>{fmt(e.at)}</span>
                      <span>{e.op}</span>
                      <span className={e.ok ? 'text-success-ink' : 'text-destructive-ink'}>
                        {e.ok ? t('ok') : (e.errorCode ?? t('failedOp'))}
                      </span>
                      {e.ref && <span dir="ltr">{e.ref}</span>}
                      <span dir="ltr" className="text-muted-foreground">
                        {e.storeId.slice(0, 8)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}
