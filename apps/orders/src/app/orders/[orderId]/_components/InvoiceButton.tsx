'use client';

import { useState } from 'react';
import { getApiUrl, apiPost } from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';
import { useLanguage } from '@/contexts/LanguageContext';

interface InvoiceButtonProps {
  storeId: string;
  orderId: string;
  disabled?: boolean;
}

/**
 * Invoice affordances — "View invoice" opens the rendered HTML in a new tab,
 * "Email invoice" queues a send. The invoice GET returns raw HTML (not the JSON
 * envelope), so it's fetched directly with the Bearer token and opened as a
 * blob URL — mirrors how the admin loads it, adapted to the PWA's localStorage
 * Bearer auth (the cross-origin cookie is purged for installed iOS PWAs).
 */
export function InvoiceButton({ storeId, orderId, disabled = false }: InvoiceButtonProps) {
  const { t, locale } = useLanguage();
  const ta = t.detail.actions;
  const { notify } = useToast();
  const [viewing, setViewing] = useState(false);
  const [emailing, setEmailing] = useState(false);

  const viewInvoice = async () => {
    setViewing(true);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
      const res = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/orders/${orderId}/invoice?locale=${locale}`,
        {
          credentials: 'include',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );
      if (!res.ok) {
        notify(ta.invoiceOpenFailed, 'error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) {
        // Popup blocked — fall back to a same-tab navigation.
        window.location.href = url;
      }
      // Revoke after a delay so the new tab has time to load.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      notify(ta.invoiceOpenFailed, 'error');
    } finally {
      setViewing(false);
    }
  };

  const emailInvoice = async () => {
    setEmailing(true);
    try {
      const { error } = await apiPost(
        `/api/v1/stores/${storeId}/orders/${orderId}/invoice/email`,
        {}
      );
      if (error) {
        notify(
          error.code === 'NO_EMAIL'
            ? ta.emailInvoiceNoEmail
            : error.message || ta.emailInvoiceFailed,
          'error'
        );
        return;
      }
      notify(ta.emailInvoiceSent, 'success');
    } catch {
      notify(ta.emailInvoiceFailed, 'error');
    } finally {
      setEmailing(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={viewInvoice}
        disabled={disabled || viewing}
        className="inline-flex h-11 min-w-[8rem] flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground active:bg-muted disabled:opacity-60"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 17v-2a4 4 0 014-4h6m0 0l-3-3m3 3l-3 3M3 12a9 9 0 1018 0 9 9 0 00-18 0z"
          />
        </svg>
        {t.detail.openInvoice}
      </button>
      <button
        type="button"
        onClick={emailInvoice}
        disabled={disabled || emailing}
        className="inline-flex h-11 min-w-[8rem] flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground active:bg-muted disabled:opacity-60"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
        {t.detail.emailInvoice}
      </button>
    </>
  );
}
