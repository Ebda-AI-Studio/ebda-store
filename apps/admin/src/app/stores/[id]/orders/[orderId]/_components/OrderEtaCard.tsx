'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { ETA_RETURN_NO_REF_REASONS } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '../../../../../../lib/api';

import { Button } from '@/components/ui/Button';
interface EtaReceiptRow {
  id: string;
  kind: 'sale' | 'return';
  seq: number;
  status: string;
  receiptNumber: string | null;
  longId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  qr: string | null;
  qrSvg: string | null;
}

const TONE: Record<string, string> = {
  accepted: 'text-success-ink',
  rejected: 'text-destructive-ink',
  failed: 'text-destructive-ink',
  late: 'text-destructive-ink',
  manual: 'text-warning-ink',
};

/** ETA e-receipt status for this order. Mounted only while the store has `eta_ereceipt`; renders nothing with no rows. */
export function OrderEtaCard({ storeId, orderId }: { storeId: string; orderId: string }) {
  const t = useT('eta.order');
  const [rows, setRows] = useState<EtaReceiptRow[] | null>(null);
  const locale = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const { data } = await apiGet<{ receipts: EtaReceiptRow[] }>(
      `/api/v1/stores/${storeId}/orders/${orderId}/eta`
    );
    setRows(data?.receipts ?? []);
  }, [storeId, orderId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!rows || rows.length === 0) return null;
  const latest = (r: EtaReceiptRow) => !rows.some(o => o.kind === r.kind && o.seq > r.seq);

  return (
    <section
      className="rounded-2xl border border-border bg-card p-5"
      aria-labelledby="order-eta-title"
    >
      <h2
        id="order-eta-title"
        className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground"
      >
        {t('title')}
      </h2>
      <ul className="space-y-4">
        {rows.map(r => (
          <li key={r.id} className="text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {t(r.kind === 'return' ? 'kindReturn' : 'kindSale')}
                {r.seq > 1 ? ` #${r.seq}` : ''}
              </span>
              <span className={TONE[r.status] ?? 'text-foreground'}>{t(`status.${r.status}`)}</span>
            </div>
            {r.errorCode ? (
              <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                {t('reason')}: {r.errorCode}
              </p>
            ) : null}
            {r.qr ? (
              <div className="mt-2 flex items-center gap-3">
                {/* An <img> of a data: SVG cannot run script, unlike inlining the markup. */}
                {r.qrSvg ? (
                  <img
                    src={`data:image/svg+xml;utf8,${encodeURIComponent(r.qrSvg)}`}
                    alt={t('qrAlt')}
                    width={96}
                    height={96}
                  />
                ) : null}
                <a
                  className="text-xs underline"
                  href={r.qr.split('#')[0]}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('openInPortal')}
                </a>
              </div>
            ) : null}
            {r.status === 'manual' && r.errorCode === 'reason_required' ? (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-muted-foreground">{t('reasonIntro')}</p>
                <label className="block text-xs font-medium" htmlFor={`eta-reason-${r.id}`}>
                  {t('reasonLabel')}
                </label>
                <select
                  id={`eta-reason-${r.id}`}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={picked[r.id] ?? ''}
                  onChange={e => setPicked(p => ({ ...p, [r.id]: e.target.value }))}
                >
                  <option value="">{t('reasonPlaceholder')}</option>
                  {ETA_RETURN_NO_REF_REASONS.map(o => (
                    <option key={o.code} value={o.code}>
                      {locale === 'ar' ? o.ar : o.en}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  disabled={!picked[r.id] || busy === r.id}
                  onClick={async () => {
                    setBusy(r.id);
                    await apiPost(`/api/v1/stores/${storeId}/eta/receipts/${r.id}/return-reason`, {
                      reason: picked[r.id],
                    });
                    setBusy(null);
                    void load();
                  }}
                  variant="outline"
                  size="sm"
                >
                  {t('reasonSubmit')}
                </Button>
              </div>
            ) : null}
            {latest(r) &&
            (r.status === 'failed' || r.status === 'rejected') &&
            r.kind === 'sale' ? (
              <Button
                type="button"
                disabled={busy === r.id}
                onClick={async () => {
                  setBusy(r.id);
                  await apiPost(`/api/v1/stores/${storeId}/eta/receipts/${r.id}/retry`, {});
                  setBusy(null);
                  void load();
                }}
                variant="outline"
                size="sm"
                className="mt-2"
              >
                {t('issueAgain')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
