'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button, Select } from '@force/ui';
import { ShopChrome } from '../../components';
import { useStoreContact, useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { API_URL, type Order } from '../../lib/api';

const RETURN_REASONS = [
  {
    value: 'defective',
    label: 'Item is defective or damaged',
    labelAr:
      '\u0627\u0644\u0645\u0646\u062a\u062c \u0645\u0639\u064a\u0628 \u0623\u0648 \u062a\u0627\u0644\u0641',
  },
  {
    value: 'wrong_item',
    label: 'Wrong item received',
    labelAr:
      '\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u0645\u0646\u062a\u062c \u062e\u0627\u0637\u0626',
  },
  {
    value: 'not_as_described',
    label: 'Not as described',
    labelAr: '\u0644\u0627 \u064a\u0637\u0627\u0628\u0642 \u0627\u0644\u0648\u0635\u0641',
  },
  {
    value: 'changed_mind',
    label: 'Changed my mind',
    labelAr: '\u063a\u064a\u0631\u062a \u0631\u0623\u064a\u064a',
  },
  { value: 'other', label: 'Other', labelAr: '\u0623\u062e\u0631\u0649' },
] as const;

type ReturnReason = (typeof RETURN_REASONS)[number]['value'];

/** Fetch with auth cookie attached. */
async function authFetch(url: string, options: RequestInit = {}) {
  return fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    },
  });
}

function ReturnRequestForm({ storeId }: { storeId: string }) {
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<ReturnReason | ''>('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    type: 'success' | 'error';
    text: string;
    returnNumber?: string;
  } | null>(null);

  useEffect(() => {
    // Check auth by trying to fetch profile (cookie-based auth)
    fetch(`${API_URL}/auth/me`, { credentials: 'include' })
      .then(res => setIsLoggedIn(res.ok))
      .catch(() => setIsLoggedIn(false));
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    setIsLoadingOrders(true);

    authFetch(`${API_URL}/public/orders`)
      .then(res => res.json())
      .then(json => {
        if (json.success && json.data?.orders) {
          // Only delivered orders are eligible for returns — matches the API's
          // ReturnService.create guard (order status must be exactly
          // 'delivered'). 'completed' is not a valid OrderStatus, so it never
          // matched and only made the eligibility look broader than it is.
          const eligible = (json.data.orders as Order[]).filter(o => o.status === 'delivered');
          setOrders(eligible);
        }
      })
      .catch(() => {
        // silently ignore -- user sees empty dropdown
      })
      .finally(() => setIsLoadingOrders(false));
  }, [isLoggedIn]);

  const selectedOrder = orders.find(o => o.id === selectedOrderId);

  function toggleItem(itemId: string) {
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitResult(null);

    if (!selectedOrderId) {
      setSubmitResult({
        type: 'error',
        text: t(
          'Please select an order.',
          '\u064a\u0631\u062c\u0649 \u0627\u062e\u062a\u064a\u0627\u0631 \u0637\u0644\u0628.'
        ),
      });
      return;
    }
    if (selectedItemIds.size === 0) {
      setSubmitResult({
        type: 'error',
        text: t(
          'Please select at least one item to return.',
          '\u064a\u0631\u062c\u0649 \u0627\u062e\u062a\u064a\u0627\u0631 \u0639\u0646\u0635\u0631 \u0648\u0627\u062d\u062f \u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644 \u0644\u0644\u0625\u0631\u062c\u0627\u0639.'
        ),
      });
      return;
    }
    if (!reason) {
      setSubmitResult({
        type: 'error',
        text: t(
          'Please select a return reason.',
          '\u064a\u0631\u062c\u0649 \u0627\u062e\u062a\u064a\u0627\u0631 \u0633\u0628\u0628 \u0627\u0644\u0625\u0631\u062c\u0627\u0639.'
        ),
      });
      return;
    }

    // Build the full item objects the API's createReturnSchema requires
    // (orderItemId + productId + productName + quantity) from the selected
    // order's line items. Sending only { orderItemId } — as this form used to —
    // fails Zod validation server-side, so the request never created a return.
    const items = (selectedOrder?.items ?? [])
      .filter(it => selectedItemIds.has(it.id))
      .map(it => ({
        orderItemId: it.id,
        productId: it.productId,
        productName: it.product?.name ?? '',
        quantity: it.quantity,
      }));

    if (items.length === 0) {
      setSubmitResult({
        type: 'error',
        text: t(
          'Please select at least one item to return.',
          'يرجى اختيار عنصر واحد على الأقل للإرجاع.'
        ),
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_URL}/stores/${storeId}/returns`, {
        method: 'POST',
        body: JSON.stringify({
          orderId: selectedOrderId,
          type: 'return',
          items,
          reason,
          customerNotes: notes.trim() || undefined,
        }),
      });

      const json = await res.json();

      if (res.ok && json.success) {
        const returnNumber =
          json.data?.return?.returnNumber ?? json.data?.returnNumber ?? json.returnNumber;
        setSubmitResult({
          type: 'success',
          text: t(
            'Your return request has been submitted successfully.',
            '\u062a\u0645 \u062a\u0642\u062f\u064a\u0645 \u0637\u0644\u0628 \u0627\u0644\u0625\u0631\u062c\u0627\u0639 \u0628\u0646\u062c\u0627\u062d.'
          ),
          returnNumber,
        });
        // Reset form
        setSelectedOrderId('');
        setSelectedItemIds(new Set());
        setReason('');
        setNotes('');
      } else {
        setSubmitResult({
          type: 'error',
          text:
            json.error?.message ||
            t(
              'Failed to submit return request. Please try again.',
              '\u0641\u0634\u0644 \u062a\u0642\u062f\u064a\u0645 \u0637\u0644\u0628 \u0627\u0644\u0625\u0631\u062c\u0627\u0639. \u064a\u0631\u062c\u0649 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649.'
            ),
        });
      }
    } catch {
      setSubmitResult({
        type: 'error',
        text: t(
          'Failed to submit return request. Please check your connection.',
          '\u0641\u0634\u0644 \u062a\u0642\u062f\u064a\u0645 \u0637\u0644\u0628 \u0627\u0644\u0625\u0631\u062c\u0627\u0639. \u064a\u0631\u062c\u0649 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u062a\u0635\u0627\u0644\u0643.'
        ),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isLoggedIn) {
    return (
      <section className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-foreground">
          {t('Request a Return', '\u0637\u0644\u0628 \u0625\u0631\u062c\u0627\u0639')}
        </h2>
        <p className="mt-3 text-muted-foreground">
          <Link
            href={`${storeUrl('/auth/login')}?redirect=${encodeURIComponent('/returns')}`}
            className="font-medium text-primary hover:underline"
          >
            {t('Log in', '\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644')}
          </Link>{' '}
          {t(
            'to submit a return request for one of your orders.',
            '\u0644\u062a\u0642\u062f\u064a\u0645 \u0637\u0644\u0628 \u0625\u0631\u062c\u0627\u0639 \u0644\u0623\u062d\u062f \u0637\u0644\u0628\u0627\u062a\u0643.'
          )}
        </p>
      </section>
    );
  }

  if (submitResult?.type === 'success') {
    return (
      <section className="rounded-xl border bg-card p-8 shadow-sm text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[hsl(var(--success))]/20">
          <svg
            className="h-7 w-7 text-[hsl(var(--success))]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="mt-4 text-xl font-semibold text-foreground">
          {t(
            'Return Request Submitted',
            '\u062a\u0645 \u062a\u0642\u062f\u064a\u0645 \u0637\u0644\u0628 \u0627\u0644\u0625\u0631\u062c\u0627\u0639'
          )}
        </h2>
        <p className="mt-2 text-muted-foreground">{submitResult.text}</p>
        {submitResult.returnNumber && (
          <p className="mt-2 text-sm text-muted-foreground">
            {t('Return number:', '\u0631\u0642\u0645 \u0627\u0644\u0625\u0631\u062c\u0627\u0639:')}{' '}
            <span className="font-mono font-semibold text-foreground">
              #{submitResult.returnNumber}
            </span>
          </p>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          {t(
            'We will review your request and contact you shortly.',
            '\u0633\u0646\u0631\u0627\u062c\u0639 \u0637\u0644\u0628\u0643 \u0648\u0646\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0643 \u0642\u0631\u064a\u0628\u0627\u064b.'
          )}
        </p>
        <button
          onClick={() => setSubmitResult(null)}
          className="mt-6 text-sm font-medium text-primary hover:underline"
        >
          {t(
            'Submit another return',
            '\u062a\u0642\u062f\u064a\u0645 \u0625\u0631\u062c\u0627\u0639 \u0622\u062e\u0631'
          )}
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-foreground">
        {t('Request a Return', '\u0637\u0644\u0628 \u0625\u0631\u062c\u0627\u0639')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          'Fill out the form below to start a return for a delivered order.',
          '\u0627\u0645\u0644\u0623 \u0627\u0644\u0646\u0645\u0648\u0630\u062c \u0623\u062f\u0646\u0627\u0647 \u0644\u0628\u062f\u0621 \u0625\u0631\u062c\u0627\u0639 \u0637\u0644\u0628 \u062a\u0645 \u062a\u0648\u0635\u064a\u0644\u0647.'
        )}
      </p>

      {submitResult?.type === 'error' && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {submitResult.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="return-order" className="block text-sm font-medium text-foreground mb-1">
            {t('Select Order', '\u0627\u062e\u062a\u0631 \u0627\u0644\u0637\u0644\u0628')}{' '}
            <span className="text-destructive">*</span>
          </label>
          {isLoadingOrders ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              {t(
                'Loading your orders...',
                '\u062c\u0627\u0631\u064a \u062a\u062d\u0645\u064a\u0644 \u0637\u0644\u0628\u0627\u062a\u0643...'
              )}
            </div>
          ) : (
            <Select
              id="return-order"
              value={selectedOrderId}
              onChange={e => {
                setSelectedOrderId(e.target.value);
                setSelectedItemIds(new Set());
              }}
              required
              options={[
                {
                  value: '',
                  label: t(
                    '-- Select an order --',
                    '-- \u0627\u062e\u062a\u0631 \u0637\u0644\u0628\u0627\u064b --'
                  ),
                },
                ...orders.map(order => ({
                  value: order.id,
                  label: `#${order.orderNumber}${
                    order.items.length > 0 && order.items[0].product?.name
                      ? ` \u2014 ${order.items[0].product.name}${order.items.length > 1 ? ` (+${order.items.length - 1} more)` : ''}`
                      : ''
                  }`,
                })),
              ]}
              className="w-full rounded-lg border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          )}
          {!isLoadingOrders && orders.length === 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'No eligible orders found. Only delivered orders can be returned.',
                '\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0637\u0644\u0628\u0627\u062a \u0645\u0624\u0647\u0644\u0629. \u064a\u0645\u0643\u0646 \u0625\u0631\u062c\u0627\u0639 \u0627\u0644\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u0645\u0633\u0644\u0645\u0629 \u0641\u0642\u0637.'
              )}
            </p>
          )}
        </div>

        {selectedOrder && selectedOrder.items.length > 0 && (
          <div>
            <p className="block text-sm font-medium text-foreground mb-2">
              {t(
                'Select Items to Return',
                '\u0627\u062e\u062a\u0631 \u0627\u0644\u0639\u0646\u0627\u0635\u0631 \u0644\u0644\u0625\u0631\u062c\u0627\u0639'
              )}{' '}
              <span className="text-destructive">*</span>
            </p>
            <div className="space-y-2">
              {selectedOrder.items.map(item => (
                <label
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 cursor-pointer hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={selectedItemIds.has(item.id)}
                    onChange={() => toggleItem(item.id)}
                    className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <span className="flex-1 text-sm text-foreground">
                    {item.product?.name || `Item #${item.id.slice(0, 8)}`}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t('Qty', '\u0627\u0644\u0643\u0645\u064a\u0629')}: {item.quantity}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div>
          <Select
            id="return-reason"
            label={`${t('Reason for Return', '\u0633\u0628\u0628 \u0627\u0644\u0625\u0631\u062c\u0627\u0639')} *`}
            value={reason}
            onChange={e => setReason(e.target.value as ReturnReason)}
            required
            options={[
              {
                value: '',
                label: t(
                  '-- Select a reason --',
                  '-- \u0627\u062e\u062a\u0631 \u0633\u0628\u0628\u0627\u064b --'
                ),
              },
              ...RETURN_REASONS.map(r => ({ value: r.value, label: t(r.label, r.labelAr) })),
            ]}
            className="w-full rounded-lg border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div>
          <label htmlFor="return-notes" className="block text-sm font-medium text-foreground mb-1">
            {t(
              'Additional Notes (optional)',
              '\u0645\u0644\u0627\u062d\u0638\u0627\u062a \u0625\u0636\u0627\u0641\u064a\u0629 (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'
            )}
          </label>
          <textarea
            id="return-notes"
            rows={4}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={t(
              'Describe the issue in more detail...',
              '\u0635\u0641 \u0627\u0644\u0645\u0634\u0643\u0644\u0629 \u0628\u0645\u0632\u064a\u062f \u0645\u0646 \u0627\u0644\u062a\u0641\u0635\u064a\u0644...'
            )}
            className="w-full rounded-lg border border-border px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none sm:text-sm"
          />
        </div>

        <div className="pt-2">
          <Button type="submit" isLoading={isSubmitting}>
            {t(
              'Submit Return Request',
              '\u062a\u0642\u062f\u064a\u0645 \u0637\u0644\u0628 \u0627\u0644\u0625\u0631\u062c\u0627\u0639'
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}

export default function ReturnsClient() {
  const { email } = useStoreContact();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const returnsEmail =
    email || t('our support team', '\u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645');
  return (
    <ShopChrome>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-foreground">
            {t(
              'Returns & Refunds',
              '\u0627\u0644\u0645\u0631\u062a\u062c\u0639\u0627\u062a \u0648\u0627\u0644\u0627\u0633\u062a\u0628\u062f\u0627\u0644'
            )}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              'Our hassle-free return policy',
              '\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0625\u0631\u062c\u0627\u0639 \u0627\u0644\u0633\u0647\u0644\u0629 \u0644\u062f\u064a\u0646\u0627'
            )}
          </p>
        </div>

        <div className="mt-12 space-y-8">
          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[hsl(var(--success))]/20">
                <svg
                  className="h-5 w-5 text-[hsl(var(--success))]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-foreground">
                {t(
                  '30-Day Return Policy',
                  '\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0625\u0631\u062c\u0627\u0639 \u062e\u0644\u0627\u0644 30 \u064a\u0648\u0645\u0627\u064b'
                )}
              </h2>
            </div>
            <p className="mt-4 text-muted-foreground">
              {t(
                "We want you to be completely satisfied with your purchase. If you're not happy with your order, you can return it within 30 days of delivery for a full refund or exchange.",
                '\u0646\u0631\u064a\u062f\u0643 \u0623\u0646 \u062a\u0643\u0648\u0646 \u0631\u0627\u0636\u064a\u0627\u064b \u062a\u0645\u0627\u0645\u0627\u064b \u0639\u0646 \u0645\u0634\u062a\u0631\u064a\u0627\u062a\u0643. \u0625\u0630\u0627 \u0644\u0645 \u062a\u0643\u0646 \u0633\u0639\u064a\u062f\u0627\u064b \u0628\u0637\u0644\u0628\u0643\u060c \u064a\u0645\u0643\u0646\u0643 \u0625\u0631\u062c\u0627\u0639\u0647 \u062e\u0644\u0627\u0644 30 \u064a\u0648\u0645\u0627\u064b \u0645\u0646 \u0627\u0644\u062a\u0648\u0635\u064a\u0644 \u0644\u0627\u0633\u062a\u0631\u062f\u0627\u062f \u0643\u0627\u0645\u0644 \u0627\u0644\u0645\u0628\u0644\u063a \u0623\u0648 \u0627\u0644\u0627\u0633\u062a\u0628\u062f\u0627\u0644.'
              )}
            </p>
          </section>

          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t(
                'Return Eligibility',
                '\u0623\u0647\u0644\u064a\u0629 \u0627\u0644\u0625\u0631\u062c\u0627\u0639'
              )}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                'To be eligible for a return, items must be:',
                '\u0644\u062a\u0643\u0648\u0646 \u0645\u0624\u0647\u0644\u0627\u064b \u0644\u0644\u0625\u0631\u062c\u0627\u0639\u060c \u064a\u062c\u0628 \u0623\u0646 \u062a\u0643\u0648\u0646 \u0627\u0644\u0639\u0646\u0627\u0635\u0631:'
              )}
            </p>
            <ul className="mt-4 space-y-3">
              <li className="flex items-start gap-3">
                <svg
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-muted-foreground">
                  {t(
                    'Unused and in original condition',
                    '\u063a\u064a\u0631 \u0645\u0633\u062a\u062e\u062f\u0645\u0629 \u0648\u0628\u062d\u0627\u0644\u062a\u0647\u0627 \u0627\u0644\u0623\u0635\u0644\u064a\u0629'
                  )}
                </span>
              </li>
              <li className="flex items-start gap-3">
                <svg
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-muted-foreground">
                  {t(
                    'In original packaging with all tags attached',
                    '\u0641\u064a \u0627\u0644\u0639\u0628\u0648\u0629 \u0627\u0644\u0623\u0635\u0644\u064a\u0629 \u0645\u0639 \u062c\u0645\u064a\u0639 \u0627\u0644\u0628\u0637\u0627\u0642\u0627\u062a'
                  )}
                </span>
              </li>
              <li className="flex items-start gap-3">
                <svg
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-muted-foreground">
                  {t(
                    'Accompanied by the original receipt or proof of purchase',
                    '\u0645\u0631\u0641\u0642\u0629 \u0628\u0627\u0644\u0625\u064a\u0635\u0627\u0644 \u0627\u0644\u0623\u0635\u0644\u064a \u0623\u0648 \u0625\u062b\u0628\u0627\u062a \u0627\u0644\u0634\u0631\u0627\u0621'
                  )}
                </span>
              </li>
            </ul>
          </section>

          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t(
                'How to Return an Item',
                '\u0643\u064a\u0641\u064a\u0629 \u0625\u0631\u062c\u0627\u0639 \u0645\u0646\u062a\u062c'
              )}
            </h2>
            <div className="mt-4 space-y-4">
              {[
                {
                  step: '1',
                  title: t('Contact Us', '\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0646\u0627'),
                  desc: t(
                    `Email us at ${returnsEmail} with your order number and reason for return.`,
                    `\u0631\u0627\u0633\u0644\u0646\u0627 \u0639\u0644\u0649 ${returnsEmail} \u0645\u0639 \u0631\u0642\u0645 \u0637\u0644\u0628\u0643 \u0648\u0633\u0628\u0628 \u0627\u0644\u0625\u0631\u062c\u0627\u0639.`
                  ),
                },
                {
                  step: '2',
                  title: t(
                    'Get Return Label',
                    '\u0627\u0644\u062d\u0635\u0648\u0644 \u0639\u0644\u0649 \u0645\u0644\u0635\u0642 \u0627\u0644\u0625\u0631\u062c\u0627\u0639'
                  ),
                  desc: t(
                    "We'll send you a prepaid return shipping label via email.",
                    '\u0633\u0646\u0631\u0633\u0644 \u0644\u0643 \u0645\u0644\u0635\u0642 \u0634\u062d\u0646 \u0625\u0631\u062c\u0627\u0639 \u0645\u062f\u0641\u0648\u0639 \u0645\u0633\u0628\u0642\u0627\u064b \u0639\u0628\u0631 \u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a.'
                  ),
                },
                {
                  step: '3',
                  title: t(
                    'Ship the Item',
                    '\u0634\u062d\u0646 \u0627\u0644\u0645\u0646\u062a\u062c'
                  ),
                  desc: t(
                    'Pack the item securely and drop it off at any authorized shipping location.',
                    '\u0642\u0645 \u0628\u062a\u063a\u0644\u064a\u0641 \u0627\u0644\u0645\u0646\u062a\u062c \u0628\u0634\u0643\u0644 \u0622\u0645\u0646 \u0648\u062a\u0633\u0644\u064a\u0645\u0647 \u0641\u064a \u0623\u064a \u0645\u0648\u0642\u0639 \u0634\u062d\u0646 \u0645\u0639\u062a\u0645\u062f.'
                  ),
                },
                {
                  step: '4',
                  title: t(
                    'Receive Refund',
                    '\u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u0645\u0628\u0644\u063a \u0627\u0644\u0645\u0633\u062a\u0631\u062f'
                  ),
                  desc: t(
                    "Once we receive and inspect the item, we'll process your refund within 5-7 business days.",
                    '\u0628\u0645\u062c\u0631\u062f \u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u0645\u0646\u062a\u062c \u0648\u0641\u062d\u0635\u0647\u060c \u0633\u0646\u0642\u0648\u0645 \u0628\u0645\u0639\u0627\u0644\u062c\u0629 \u0627\u0633\u062a\u0631\u062f\u0627\u062f \u0627\u0644\u0645\u0628\u0644\u063a \u062e\u0644\u0627\u0644 5-7 \u0623\u064a\u0627\u0645 \u0639\u0645\u0644.'
                  ),
                },
              ].map(({ step, title, desc }) => (
                <div key={step} className="flex gap-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                    {step}
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground">{title}</h3>
                    <p className="text-sm text-muted-foreground">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t(
                'Refund Information',
                '\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u0627\u0633\u062a\u0631\u062f\u0627\u062f'
              )}
            </h2>
            <ul className="mt-4 space-y-2 text-muted-foreground">
              <li>
                {t(
                  'Refunds will be credited to your original payment method',
                  '\u0633\u064a\u062a\u0645 \u0625\u0631\u062c\u0627\u0639 \u0627\u0644\u0645\u0628\u0644\u063a \u0625\u0644\u0649 \u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u062f\u0641\u0639 \u0627\u0644\u0623\u0635\u0644\u064a\u0629'
                )}
              </li>
              <li>
                {t(
                  'Please allow 5-7 business days for the refund to appear',
                  '\u064a\u0631\u062c\u0649 \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631 5-7 \u0623\u064a\u0627\u0645 \u0639\u0645\u0644 \u0644\u0638\u0647\u0648\u0631 \u0627\u0644\u0645\u0628\u0644\u063a \u0627\u0644\u0645\u0633\u062a\u0631\u062f'
                )}
              </li>
              <li>
                {t(
                  'Original shipping costs are non-refundable (unless the item was defective)',
                  '\u062a\u0643\u0627\u0644\u064a\u0641 \u0627\u0644\u0634\u062d\u0646 \u0627\u0644\u0623\u0635\u0644\u064a\u0629 \u063a\u064a\u0631 \u0642\u0627\u0628\u0644\u0629 \u0644\u0644\u0627\u0633\u062a\u0631\u062f\u0627\u062f (\u0645\u0627 \u0644\u0645 \u064a\u0643\u0646 \u0627\u0644\u0645\u0646\u062a\u062c \u0645\u0639\u064a\u0628\u0627\u064b)'
                )}
              </li>
              <li>
                {t(
                  'Sale items are final sale and cannot be returned',
                  '\u0627\u0644\u0639\u0646\u0627\u0635\u0631 \u0627\u0644\u0645\u062e\u0641\u0636\u0629 \u0646\u0647\u0627\u0626\u064a\u0629 \u0648\u0644\u0627 \u064a\u0645\u0643\u0646 \u0625\u0631\u062c\u0627\u0639\u0647\u0627'
                )}
              </li>
            </ul>
          </section>

          {/* Return Request Form */}
          {store.id && store.id !== 'demo' && <ReturnRequestForm storeId={store.id} />}
        </div>

        <div className="mt-8 text-center">
          <p className="text-muted-foreground">
            {t(
              'Need help with a return?',
              '\u0647\u0644 \u062a\u062d\u062a\u0627\u062c \u0645\u0633\u0627\u0639\u062f\u0629 \u0641\u064a \u0627\u0644\u0625\u0631\u062c\u0627\u0639\u061f'
            )}{' '}
            <Link href={storeUrl('/contact')} className="text-primary hover:underline">
              {t(
                'Contact our support team',
                '\u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645'
              )}
            </Link>
          </p>
        </div>
      </div>
    </ShopChrome>
  );
}
