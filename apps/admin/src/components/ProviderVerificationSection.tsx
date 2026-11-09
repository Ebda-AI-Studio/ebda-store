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
import { apiGet, apiPost } from '../lib/api';
import { useT } from '../i18n/useT';

interface Row {
  provider: string;
  kind: string;
  catalogVerified: boolean;
  successCount: number;
  failureCount: number;
  liveStores: number;
  needed: number;
  readyAt: string | null;
  verifiedAt: string | null;
  recent: Array<{
    storeId: string;
    op: string;
    mode: string;
    counted: boolean;
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
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

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
  }, [reload]);

  async function confirmProvider(provider: string) {
    setBusy(provider);
    const { error } = await apiPost(`/api/v1/admin/provider-verification/${provider}/confirm`);
    setBusy(null);
    if (error) setFailed(true);
    else setReload(k => k + 1);
  }

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
                <Badge variant={verified ? 'success' : r.readyAt ? 'info' : 'warning'}>
                  {verified
                    ? r.catalogVerified
                      ? t('verifiedCatalog')
                      : t('verifiedConfirmed', { at: fmt(r.verifiedAt!) })
                    : r.readyAt
                      ? t('ready')
                      : t('unverified')}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {t('counts', {
                    stores: r.liveStores,
                    needed: r.needed,
                    ok: r.successCount,
                    failed: r.failureCount,
                  })}
                </span>
                {!verified && r.readyAt && (
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1 text-sm"
                    disabled={busy === r.provider}
                    onClick={e => {
                      e.preventDefault();
                      void confirmProvider(r.provider);
                    }}
                  >
                    {t('confirm')}
                  </button>
                )}
              </summary>
              {r.recent.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">{t('noEvidence')}</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {r.recent.map((e, i) => (
                    <li key={`${e.at}-${i}`} className="flex flex-wrap gap-x-3">
                      <span>{fmt(e.at)}</span>
                      <span>{e.op}</span>
                      <span>
                        {e.mode}
                        {e.counted ? ' ✓' : ''}
                      </span>
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
