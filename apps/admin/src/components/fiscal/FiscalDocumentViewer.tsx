'use client';

import { Button } from '@/components/ui/Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { apiFetch } from '../../lib/api';

interface FiscalDocumentViewerProps {
  /** API path of the document's HTML, without the query string. */
  endpoint: string;
  /** Where "Back" goes. */
  backHref: string;
}

/**
 * Shows a fiscal document exactly as issued. The HTML is fetched through apiFetch (so the
 * Bearer/cookie auth works on iOS PWAs, same as the order invoice page) and rendered in a
 * srcDoc iframe so the browser's print dialog prints only the document. The
 * merchant can flip the document language without re-issuing anything: the API renders the
 * stored figures in either language.
 */
export function FiscalDocumentViewer({ endpoint, backHref }: FiscalDocumentViewerProps) {
  const t = useT('invoices.viewer');
  const adminLocale = useLocale();
  const router = useRouter();
  const { error: toastError } = useToast();
  const [docLocale, setDocLocale] = useState<'ar' | 'en'>(adminLocale === 'en' ? 'en' : 'ar');
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`${endpoint}?locale=${docLocale}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setHtml(text);
      } catch {
        if (!cancelled) setError(t('loadFailed'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, docLocale, t]);

  const handlePrint = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) {
      toastError(t('printFailed'));
      return;
    }
    win.focus();
    win.print();
  }, [t, toastError]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
      <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-background/95 p-2 backdrop-blur print:hidden">
        <Button
          variant="secondary"
          type="button"
          onClick={() => router.push(backHref)}
          className="gap-2"
        >
          <svg
            className={`h-4 w-4 ${adminLocale === 'ar' ? 'rotate-180' : ''}`}
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
          {t('back')}
        </Button>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label={t('language')}
            className="flex rounded-xl border border-border bg-card p-0.5"
          >
            {(['ar', 'en'] as const).map(l => (
              <Button
                variant={docLocale === l ? 'soft' : 'ghost'}
                size="sm"
                key={l}
                type="button"
                aria-pressed={docLocale === l}
                onClick={() => setDocLocale(l)}
              >
                {t(l === 'ar' ? 'arabic' : 'english')}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            onClick={handlePrint}
            disabled={!html}
            className="gap-2 font-semibold"
          >
            {t('print')}
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center"
        >
          <p className="text-sm text-destructive-ink">{error}</p>
        </div>
      )}
      {!error && !html && (
        <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {t('loading')}
        </div>
      )}
      {!error && html && (
        <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm print:rounded-none print:border-0 print:shadow-none">
          <iframe
            ref={iframeRef}
            title={t('title')}
            srcDoc={html}
            // The document is inert markup: NO allow-scripts, so nothing in it can execute. `allow-same-origin` lets the
            // parent call contentWindow.print() (cross-origin print() throws); it is safe because scripts stay off.
            // `allow-modals` is what the browser requires for print() inside a sandboxed frame. Nothing else is granted.
            sandbox="allow-same-origin allow-modals"
            className="w-full"
            style={{ height: '85vh', border: 0 }}
          />
        </div>
      )}
    </div>
  );
}
