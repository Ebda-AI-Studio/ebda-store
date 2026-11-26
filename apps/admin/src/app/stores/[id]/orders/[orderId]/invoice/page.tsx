'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiFetch } from '../../../../../../lib/api';
import { useRequireFeature } from '../../../../../../hooks/useRequireFeature';

import { Button } from '@/components/ui/Button';
export default function OrderInvoicePage() {
  const { gate } = useRequireFeature('accounting.invoicing');

  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const orderId = params?.orderId as string;
  const t = useT('orders.invoice');
  const tDetail = useT('orders.detail');
  const locale = useLocale();
  const { error: toastError, success: toastSuccess } = useToast();

  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Pass the admin UI locale so the invoice renders in the same
        // language the admin is currently using (AR → Arabic RTL invoice,
        // EN → English invoice). The API falls back to order.locale when
        // this param is absent.
        const res = await apiFetch(
          `/api/v1/stores/${storeId}/orders/${orderId}/invoice?locale=${encodeURIComponent(locale)}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setHtml(text);
      } catch {
        if (!cancelled) setError(t('errors.loadFailed'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, orderId, t]);

  const handlePrint = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) {
      toastError(t('errors.printFailed'));
      return;
    }
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  }, [t, toastError]);

  const handleDownloadPdf = useCallback(() => {
    // Browsers expose "Save as PDF" inside the print dialog. Same iframe print
    // call surfaces it — no separate code path needed.
    handlePrint();
  }, [handlePrint]);

  const handleEmail = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/v1/stores/${storeId}/orders/${orderId}/invoice/email`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error();
      toastSuccess(t('toast.emailSent'));
    } catch {
      toastError(t('errors.emailFailed'));
    }
  }, [storeId, orderId, t, toastError, toastSuccess]);

  if (gate) return gate;

  return (
    <AdminLayout mode="store_admin" storeId={storeId} title={t('title')}>
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
        {/* Toolbar */}
        <div className="sticky top-0 z-10 mb-4 flex items-center justify-between gap-2 rounded-lg border border-border bg-background/95 p-2 backdrop-blur print:hidden">
          <Button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/orders/${orderId}`)}
            variant="secondary"
            className="gap-2"
          >
            <svg
              className={`h-4 w-4 ${locale === 'ar' ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            {tDetail('back')}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" onClick={handleEmail} variant="outline" className="gap-2">
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
              <span className="hidden sm:inline">{t('actions.email')}</span>
            </Button>
            <Button type="button" onClick={handleDownloadPdf} variant="outline" className="gap-2">
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              <span className="hidden sm:inline">{t('actions.downloadPdf')}</span>
            </Button>
            <Button
              type="button"
              onClick={handlePrint}
              variant="default"
              className="gap-2 font-semibold"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                />
              </svg>
              {t('actions.print')}
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive-ink">{error}</p>
          </div>
        )}

        {!error && !html && (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t('loading')}
          </div>
        )}

        {!error && html && (
          <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm print:rounded-none print:border-0 print:shadow-none">
            <iframe
              ref={iframeRef}
              title={t('title')}
              // The document's own Print button uses an inline onclick, which the admin CSP
              // (script-src-attr 'none') blocks in this inheriting srcdoc frame; the page has its own.
              srcDoc={html.replace(/<div class="actions no-print">[\s\S]*?<\/div>/, '')}
              className="w-full"
              style={{ height: '85vh', border: 0 }}
            />
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
