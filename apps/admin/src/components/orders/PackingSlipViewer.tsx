'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { apiFetch } from '../../lib/api';

/** Mirrors PACKING_SLIP_MAX_ORDERS in the API. */
export const PACKING_SLIP_MAX = 100;

type Size = 'a4' | 'label';

/**
 * Loads the printable packing slip(s) from the API (one page per order) and
 * prints them from a sandboxed frame. One order = GET, several = POST, both
 * tenant-scoped on the server; the admin UI language picks the slip language.
 */
export function PackingSlipViewer({ storeId, orderIds }: { storeId: string; orderIds: string[] }) {
  const t = useT('packingSlip');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [size, setSize] = useState<Size>('a4');
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const tooMany = orderIds.length > PACKING_SLIP_MAX;
  const key = orderIds.join(',');

  useEffect(() => {
    if (tooMany || orderIds.length === 0) return;
    let cancelled = false;
    setHtml(null);
    setFailed(false);
    setSkipped(0);
    (async () => {
      try {
        const res =
          orderIds.length === 1
            ? await apiFetch(
                `/api/v1/stores/${storeId}/orders/${orderIds[0]}/packing-slip?size=${size}&locale=${locale}`
              )
            : await apiFetch(`/api/v1/stores/${storeId}/orders/packing-slips`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds, size, locale }),
              });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const skippedHeader = res.headers?.get('X-Packing-Slips-Skipped');
        if (!cancelled) {
          setSkipped(skippedHeader ? skippedHeader.split(',').filter(Boolean).length : 0);
          setHtml(text);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, key, size, locale, tooMany]);

  const print = () => {
    frame.current?.contentWindow?.focus();
    frame.current?.contentWindow?.print();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label={t('size')} className="flex gap-1">
          {(['a4', 'label'] as const).map(s => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={size === s}
              aria-label={s === 'a4' ? t('sizeA4') : t('sizeLabel')}
              onClick={() => setSize(s)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                size === s
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted'
              }`}
            >
              {s === 'a4' ? t('sizeA4') : t('sizeLabel')}
            </button>
          ))}
        </div>
        <Button type="button" onClick={print} disabled={!html}>
          {t('print')}
        </Button>
      </div>
      {tooMany && (
        <p role="alert" className="text-sm text-destructive-ink">
          {t('tooMany')}
        </p>
      )}
      {skipped > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('skipped', { count: skipped })}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive-ink">
          {t('loadFailed')}
        </p>
      )}
      {!html && !failed && !tooMany && (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      )}
      {html && (
        <iframe
          ref={frame}
          title={t('title')}
          srcDoc={html}
          sandbox="allow-same-origin allow-modals"
          className="h-[75vh] w-full rounded-lg border border-border bg-white"
        />
      )}
    </div>
  );
}
