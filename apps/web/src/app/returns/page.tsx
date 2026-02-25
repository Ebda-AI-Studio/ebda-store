'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@force/ui';
import { Header, Footer } from '../../components';
import { useStoreContact, useStore } from '../../contexts/StoreContext';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

const RETURN_REASONS = [
  { value: 'defective', label: 'Item is defective or damaged' },
  { value: 'wrong_item', label: 'Wrong item received' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'changed_mind', label: 'Changed my mind' },
  { value: 'other', label: 'Other' },
] as const;

type ReturnReason = (typeof RETURN_REASONS)[number]['value'];

interface OrderItem {
  id: string;
  productId?: string;
  quantity: number;
  price: number;
  product?: { name: string };
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  items: OrderItem[];
}

/** Fetch with auth token attached. */
async function authFetch(url: string, options: RequestInit = {}) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers as Record<string, string>),
    },
  });
}

function ReturnRequestForm({ storeId }: { storeId: string }) {
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
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    setIsLoggedIn(!!token);
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    setIsLoadingOrders(true);

    authFetch(`${API_URL}/public/orders`)
      .then(res => res.json())
      .then(json => {
        if (json.success && json.data?.orders) {
          // Only orders that are delivered (eligible for returns)
          const eligible = (json.data.orders as Order[]).filter(o =>
            ['delivered', 'completed'].includes(o.status)
          );
          setOrders(eligible);
        }
      })
      .catch(() => {
        // silently ignore — user sees empty dropdown
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
      setSubmitResult({ type: 'error', text: 'Please select an order.' });
      return;
    }
    if (selectedItemIds.size === 0) {
      setSubmitResult({ type: 'error', text: 'Please select at least one item to return.' });
      return;
    }
    if (!reason) {
      setSubmitResult({ type: 'error', text: 'Please select a return reason.' });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await authFetch(`${API_URL}/stores/${storeId}/returns`, {
        method: 'POST',
        body: JSON.stringify({
          orderId: selectedOrderId,
          items: Array.from(selectedItemIds).map(id => ({ orderItemId: id })),
          reason,
          notes: notes.trim() || undefined,
        }),
      });

      const json = await res.json();

      if (res.ok && json.success) {
        const returnNumber =
          json.data?.return?.returnNumber ?? json.data?.returnNumber ?? json.returnNumber;
        setSubmitResult({
          type: 'success',
          text: 'Your return request has been submitted successfully.',
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
          text: json.error?.message || 'Failed to submit return request. Please try again.',
        });
      }
    } catch {
      setSubmitResult({
        type: 'error',
        text: 'Failed to submit return request. Please check your connection.',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isLoggedIn) {
    return (
      <section className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-gray-900">Request a Return</h2>
        <p className="mt-3 text-gray-600">
          <Link href="/auth/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>{' '}
          to submit a return request for one of your orders.
        </p>
      </section>
    );
  }

  if (submitResult?.type === 'success') {
    return (
      <section className="rounded-xl border bg-white p-8 shadow-sm text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
          <svg
            className="h-7 w-7 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="mt-4 text-xl font-semibold text-gray-900">Return Request Submitted</h2>
        <p className="mt-2 text-gray-600">{submitResult.text}</p>
        {submitResult.returnNumber && (
          <p className="mt-2 text-sm text-gray-500">
            Return number:{' '}
            <span className="font-mono font-semibold text-gray-800">
              #{submitResult.returnNumber}
            </span>
          </p>
        )}
        <p className="mt-4 text-sm text-gray-500">
          We will review your request and contact you shortly.
        </p>
        <button
          onClick={() => setSubmitResult(null)}
          className="mt-6 text-sm font-medium text-primary hover:underline"
        >
          Submit another return
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-gray-900">Request a Return</h2>
      <p className="mt-1 text-sm text-gray-500">
        Fill out the form below to start a return for a delivered order.
      </p>

      {submitResult?.type === 'error' && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {submitResult.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        {/* Order selector */}
        <div>
          <label htmlFor="return-order" className="block text-sm font-medium text-gray-700 mb-1">
            Select Order <span className="text-red-500">*</span>
          </label>
          {isLoadingOrders ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              Loading your orders...
            </div>
          ) : (
            <select
              id="return-order"
              value={selectedOrderId}
              onChange={e => {
                setSelectedOrderId(e.target.value);
                setSelectedItemIds(new Set());
              }}
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">-- Select an order --</option>
              {orders.map(order => (
                <option key={order.id} value={order.id}>
                  #{order.orderNumber}{' '}
                  {order.items.length > 0 && order.items[0].product?.name
                    ? `— ${order.items[0].product.name}${order.items.length > 1 ? ` (+${order.items.length - 1} more)` : ''}`
                    : ''}
                </option>
              ))}
            </select>
          )}
          {!isLoadingOrders && orders.length === 0 && (
            <p className="mt-1 text-sm text-gray-500">
              No eligible orders found. Only delivered orders can be returned.
            </p>
          )}
        </div>

        {/* Item checkboxes */}
        {selectedOrder && selectedOrder.items.length > 0 && (
          <div>
            <p className="block text-sm font-medium text-gray-700 mb-2">
              Select Items to Return <span className="text-red-500">*</span>
            </p>
            <div className="space-y-2">
              {selectedOrder.items.map(item => (
                <label
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 cursor-pointer hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={selectedItemIds.has(item.id)}
                    onChange={() => toggleItem(item.id)}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <span className="flex-1 text-sm text-gray-800">
                    {item.product?.name || `Item #${item.id.slice(0, 8)}`}
                  </span>
                  <span className="text-sm text-gray-500">Qty: {item.quantity}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Reason dropdown */}
        <div>
          <label htmlFor="return-reason" className="block text-sm font-medium text-gray-700 mb-1">
            Reason for Return <span className="text-red-500">*</span>
          </label>
          <select
            id="return-reason"
            value={reason}
            onChange={e => setReason(e.target.value as ReturnReason)}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">-- Select a reason --</option>
            {RETURN_REASONS.map(r => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* Notes textarea */}
        <div>
          <label htmlFor="return-notes" className="block text-sm font-medium text-gray-700 mb-1">
            Additional Notes (optional)
          </label>
          <textarea
            id="return-notes"
            rows={4}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Describe the issue in more detail..."
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
          />
        </div>

        <div className="pt-2">
          <Button type="submit" isLoading={isSubmitting}>
            Submit Return Request
          </Button>
        </div>
      </form>
    </section>
  );
}

export default function ReturnsPage() {
  const { email } = useStoreContact();
  const { store } = useStore();
  const returnsEmail = email || 'our support team';
  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Returns &amp; Refunds</h1>
          <p className="mt-2 text-gray-500">Our hassle-free return policy</p>
        </div>

        <div className="mt-12 space-y-8">
          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                <svg
                  className="h-5 w-5 text-green-600"
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
              <h2 className="text-xl font-semibold text-gray-900">30-Day Return Policy</h2>
            </div>
            <p className="mt-4 text-gray-600">
              We want you to be completely satisfied with your purchase. If you&apos;re not happy
              with your order, you can return it within 30 days of delivery for a full refund or
              exchange.
            </p>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">Return Eligibility</h2>
            <p className="mt-2 text-gray-600">To be eligible for a return, items must be:</p>
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
                <span className="text-gray-600">Unused and in original condition</span>
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
                <span className="text-gray-600">In original packaging with all tags attached</span>
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
                <span className="text-gray-600">
                  Accompanied by the original receipt or proof of purchase
                </span>
              </li>
            </ul>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">How to Return an Item</h2>
            <div className="mt-4 space-y-4">
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  1
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Contact Us</h3>
                  <p className="text-sm text-gray-600">
                    Email us at {returnsEmail} with your order number and reason for return.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  2
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Get Return Label</h3>
                  <p className="text-sm text-gray-600">
                    We&apos;ll send you a prepaid return shipping label via email.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  3
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Ship the Item</h3>
                  <p className="text-sm text-gray-600">
                    Pack the item securely and drop it off at any authorized shipping location.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  4
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Receive Refund</h3>
                  <p className="text-sm text-gray-600">
                    Once we receive and inspect the item, we&apos;ll process your refund within 5-7
                    business days.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">Refund Information</h2>
            <ul className="mt-4 space-y-2 text-gray-600">
              <li>Refunds will be credited to your original payment method</li>
              <li>Please allow 5-7 business days for the refund to appear</li>
              <li>Original shipping costs are non-refundable (unless the item was defective)</li>
              <li>Sale items are final sale and cannot be returned</li>
            </ul>
          </section>

          {/* Return Request Form */}
          {store.id && store.id !== 'demo' && <ReturnRequestForm storeId={store.id} />}
        </div>

        <div className="mt-8 text-center">
          <p className="text-gray-500">
            Need help with a return?{' '}
            <Link href="/contact" className="text-primary hover:underline">
              Contact our support team
            </Link>
          </p>
        </div>
      </div>

      <Footer />
    </main>
  );
}
