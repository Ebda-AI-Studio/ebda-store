'use client';

/**
 * Merchant-Initiated Payment Link page — Phase 7.
 *
 * Lets the store admin send a customer a one-tap payment link over
 * WhatsApp. Two modes:
 *   - Open amount: just type a KWD value
 *   - Cart items: TODO v2 (pick products + quantities)
 *
 * Requires the paymentLink template to be Approved on Meta first.
 */

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiPost } from '../../../../lib/api';

interface PaymentLinkResponse {
  checkoutUrl: string;
  checkoutToken: string;
  totalFils: number;
  currency: string;
  messageId?: string;
  expiresAt: string;
}

const SendIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const CopyIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
);

const CheckIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export default function PaymentLinkPage() {
  const params = useParams();
  const storeId = params.id as string;
  const { success: toastSuccess, error: toastError } = useToast();

  const [customerPhone, setCustomerPhone] = useState('+965');
  const [customerName, setCustomerName] = useState('');
  const [amountKwd, setAmountKwd] = useState('');
  const [language, setLanguage] = useState<'en' | 'ar'>('en');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PaymentLinkResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const phoneValid = /^\+[1-9]\d{6,14}$/.test(customerPhone.trim());
  const amountValid = (() => {
    const n = Number(amountKwd);
    return Number.isFinite(n) && n > 0;
  })();
  const canSend = phoneValid && amountValid && !sending;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setResult(null);
    try {
      const amountFils = Math.round(Number(amountKwd) * 1000);
      const { data: payload, error } = await apiPost<PaymentLinkResponse>(
        `/api/v1/stores/${storeId}/payment-links`,
        {
          customerPhone: customerPhone.trim(),
          customerName: customerName.trim() || undefined,
          amountFils,
          language,
        }
      );
      if (error) {
        toastError('Could not send', error.message || 'Unknown error');
        return;
      }
      if (payload) {
        setResult(payload);
        toastSuccess(
          'Payment link sent',
          `Sent to ${customerPhone} via WhatsApp. Link expires in 30 minutes.`
        );
      }
    } catch (err) {
      toastError('Send failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const copyUrl = async () => {
    if (!result?.checkoutUrl) return;
    try {
      await navigator.clipboard.writeText(result.checkoutUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // navigator.clipboard not available; ignore
    }
  };

  return (
    <AdminLayout title="Send Payment Link via WhatsApp">
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <header className="space-y-2">
          <h1 className="flex items-center gap-3 text-2xl font-bold">
            <SendIcon className="h-6 w-6 text-orange-500" />
            Send Payment Link
          </h1>
          <p className="text-sm text-gray-600">
            Send a customer a one-tap WhatsApp payment link valid for 30 minutes. Use this for
            custom quotes, invoices, or out-of-band orders. Kuwait doesn&apos;t have WhatsApp Pay so
            the customer pays through your existing Force Store checkout.
          </p>
        </header>

        <div className="rounded-lg border bg-white shadow-sm p-5 space-y-4">
          {/* Phone */}
          <div className="space-y-1.5">
            <label htmlFor="phone" className="text-sm font-medium text-gray-700">
              Customer WhatsApp number (E.164)
            </label>
            <input
              id="phone"
              type="tel"
              value={customerPhone}
              onChange={e => setCustomerPhone(e.target.value)}
              placeholder="+96512345678"
              className="w-full rounded-md border px-3 py-2 text-sm font-mono"
            />
            {!phoneValid && customerPhone.length > 4 && (
              <p className="text-[11px] text-red-600">Must start with + and be 8–16 digits.</p>
            )}
          </div>

          {/* Optional name */}
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium text-gray-700">
              Customer name (optional)
            </label>
            <input
              id="name"
              type="text"
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              placeholder="Ahmad"
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-gray-500">
              Used in the WhatsApp greeting. Leave blank for generic.
            </p>
          </div>

          {/* Amount */}
          <div className="space-y-1.5">
            <label htmlFor="amount" className="text-sm font-medium text-gray-700">
              Amount (KWD)
            </label>
            <input
              id="amount"
              type="number"
              step="0.001"
              min="0"
              value={amountKwd}
              onChange={e => setAmountKwd(e.target.value)}
              placeholder="5.500"
              className="w-full rounded-md border px-3 py-2 text-sm tabular-nums"
            />
            {amountValid && (
              <p className="text-[11px] text-gray-500">
                The customer will see &quot;{Number(amountKwd).toFixed(3)}{' '}
                {language === 'ar' ? 'د.ك' : 'KWD'}&quot; in the WhatsApp message.
              </p>
            )}
          </div>

          {/* Language */}
          <div className="space-y-1.5">
            <label htmlFor="lang" className="text-sm font-medium text-gray-700">
              WhatsApp message language
            </label>
            <select
              id="lang"
              value={language}
              onChange={e => setLanguage(e.target.value as 'en' | 'ar')}
              className="w-full rounded-md border bg-white px-3 py-2 text-sm"
            >
              <option value="en">English</option>
              <option value="ar">Arabic</option>
            </select>
          </div>

          {/* Send */}
          <Button
            onClick={send}
            disabled={!canSend}
            className="w-full bg-orange-500 hover:bg-orange-600"
          >
            <SendIcon className="me-2 h-4 w-4" />
            {sending ? 'Sending…' : 'Send payment link via WhatsApp'}
          </Button>
        </div>

        {/* Result */}
        {result && (
          <div className="rounded-lg border bg-emerald-50 border-emerald-200 p-4 space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
              <CheckIcon className="h-4 w-4" />
              Sent successfully
            </h3>
            <div className="text-xs text-emerald-800 space-y-1.5">
              <p>
                Customer will receive a WhatsApp message with the payment link. Link expires at:{' '}
                <span className="font-mono">{new Date(result.expiresAt).toLocaleString()}</span>
              </p>
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="text"
                  readOnly
                  value={result.checkoutUrl}
                  className="flex-1 rounded border bg-white px-2 py-1 text-[11px] font-mono"
                  onFocus={e => e.target.select()}
                />
                <Button onClick={copyUrl} variant="outline" className="h-7 px-2 text-xs">
                  {copied ? (
                    <CheckIcon className="h-3.5 w-3.5" />
                  ) : (
                    <CopyIcon className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              {result.messageId && (
                <p className="text-[10px] text-emerald-600 font-mono">
                  Meta message id: {result.messageId}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Footer help */}
        <div className="rounded-md border bg-blue-50/50 border-blue-200 p-3 text-xs text-blue-800">
          <strong>Requirements:</strong> the <em>paymentLink</em> template must be approved by Meta.
          If you haven&apos;t synced templates yet, visit WhatsApp Templates and click{' '}
          <em>Sync to Meta</em>. Approval typically takes 10 minutes to 24 hours.
        </div>
      </div>
    </AdminLayout>
  );
}
