'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@force/ui';
import { Header, Footer } from '../../components';
import { useStoreContact, useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

const RETURN_REASONS = [
  { value: 'defective', label: 'Item is defective or damaged', labelAr: 'المنتج معيب أو تالف' },
  { value: 'wrong_item', label: 'Wrong item received', labelAr: 'تم استلام منتج خاطئ' },
  { value: 'not_as_described', label: 'Not as described', labelAr: 'لا يطابق الوصف' },
  { value: 'changed_mind', label: 'Changed my mind', labelAr: 'غيرت رأيي' },
  { value: 'other', label: 'Other', labelAr: 'أخرى' },
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
      setSubmitResult({ type: 'error', text: t('Please select an order.', 'يرجى اختيار طلب.') });
      return;
    }
    if (selectedItemIds.size === 0) {
      setSubmitResult({
        type: 'error',
        text: t(
          'Please select at least one item to return.',
          'يرجى اختيار عنصر واحد على الأقل للإرجاع.'
        ),
      });
      return;
    }
    if (!reason) {
      setSubmitResult({
        type: 'error',
        text: t('Please select a return reason.', 'يرجى اختيار سبب الإرجاع.'),
      });
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
          text: t(
            'Your return request has been submitted successfully.',
            'تم تقديم طلب الإرجاع بنجاح.'
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
              'فشل تقديم طلب الإرجاع. يرجى المحاولة مرة أخرى.'
            ),
        });
      }
    } catch {
      setSubmitResult({
        type: 'error',
        text: t(
          'Failed to submit return request. Please check your connection.',
          'فشل تقديم طلب الإرجاع. يرجى التحقق من اتصالك.'
        ),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isLoggedIn) {
    return (
      <section className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-foreground">
          {t('Request a Return', 'طلب إرجاع')}
        </h2>
        <p className="mt-3 text-muted-foreground">
          <Link href={storeUrl('/auth/login')} className="font-medium text-primary hover:underline">
            {t('Log in', 'تسجيل الدخول')}
          </Link>{' '}
          {t('to submit a return request for one of your orders.', 'لتقديم طلب إرجاع لأحد طلباتك.')}
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
        <h2 className="mt-4 text-xl font-semibold text-foreground">
          {t('Return Request Submitted', 'تم تقديم طلب الإرجاع')}
        </h2>
        <p className="mt-2 text-muted-foreground">{submitResult.text}</p>
        {submitResult.returnNumber && (
          <p className="mt-2 text-sm text-muted-foreground">
            {t('Return number:', 'رقم الإرجاع:')}{' '}
            <span className="font-mono font-semibold text-foreground">
              #{submitResult.returnNumber}
            </span>
          </p>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          {t(
            'We will review your request and contact you shortly.',
            'سنراجع طلبك ونتواصل معك قريباً.'
          )}
        </p>
        <button
          onClick={() => setSubmitResult(null)}
          className="mt-6 text-sm font-medium text-primary hover:underline"
        >
          {t('Submit another return', 'تقديم إرجاع آخر')}
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-foreground">
        {t('Request a Return', 'طلب إرجاع')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          'Fill out the form below to start a return for a delivered order.',
          'املأ النموذج أدناه لبدء إرجاع طلب تم توصيله.'
        )}
      </p>

      {submitResult?.type === 'error' && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {submitResult.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        {/* Order selector */}
        <div>
          <label htmlFor="return-order" className="block text-sm font-medium text-foreground mb-1">
            {t('Select Order', 'اختر الطلب')} <span className="text-red-500">*</span>
          </label>
          {isLoadingOrders ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              {t('Loading your orders...', 'جاري تحميل طلباتك...')}
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
              className="w-full rounded-lg border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">{t('-- Select an order --', '-- اختر طلباً --')}</option>
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
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'No eligible orders found. Only delivered orders can be returned.',
                'لم يتم العثور على طلبات مؤهلة. يمكن إرجاع الطلبات المسلمة فقط.'
              )}
            </p>
          )}
        </div>

        {/* Item checkboxes */}
        {selectedOrder && selectedOrder.items.length > 0 && (
          <div>
            <p className="block text-sm font-medium text-foreground mb-2">
              {t('Select Items to Return', 'اختر العناصر للإرجاع')}{' '}
              <span className="text-red-500">*</span>
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
                    {t('Qty', 'الكمية')}: {item.quantity}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Reason dropdown */}
        <div>
          <label htmlFor="return-reason" className="block text-sm font-medium text-foreground mb-1">
            {t('Reason for Return', 'سبب الإرجاع')} <span className="text-red-500">*</span>
          </label>
          <select
            id="return-reason"
            value={reason}
            onChange={e => setReason(e.target.value as ReturnReason)}
            required
            className="w-full rounded-lg border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">{t('-- Select a reason --', '-- اختر سبباً --')}</option>
            {RETURN_REASONS.map(r => (
              <option key={r.value} value={r.value}>
                {t(r.label, r.labelAr)}
              </option>
            ))}
          </select>
        </div>

        {/* Notes textarea */}
        <div>
          <label htmlFor="return-notes" className="block text-sm font-medium text-foreground mb-1">
            {t('Additional Notes (optional)', 'ملاحظات إضافية (اختياري)')}
          </label>
          <textarea
            id="return-notes"
            rows={4}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={t(
              'Describe the issue in more detail...',
              'صف المشكلة بمزيد من التفصيل...'
            )}
            className="w-full rounded-lg border border-border px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
          />
        </div>

        <div className="pt-2">
          <Button type="submit" isLoading={isSubmitting}>
            {t('Submit Return Request', 'تقديم طلب الإرجاع')}
          </Button>
        </div>
      </form>
    </section>
  );
}

export default function ReturnsPage() {
  const { email } = useStoreContact();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const returnsEmail = email || t('our support team', 'فريق الدعم');
  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-foreground">
            {t('Returns & Refunds', 'المرتجعات والاستبدال')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t('Our hassle-free return policy', 'سياسة الإرجاع السهلة لدينا')}
          </p>
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
              <h2 className="text-xl font-semibold text-foreground">
                {t('30-Day Return Policy', 'سياسة الإرجاع خلال 30 يوماً')}
              </h2>
            </div>
            <p className="mt-4 text-muted-foreground">
              {t(
                "We want you to be completely satisfied with your purchase. If you're not happy with your order, you can return it within 30 days of delivery for a full refund or exchange.",
                'نريدك أن تكون راضياً تماماً عن مشترياتك. إذا لم تكن سعيداً بطلبك، يمكنك إرجاعه خلال 30 يوماً من التوصيل لاسترداد كامل المبلغ أو الاستبدال.'
              )}
            </p>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t('Return Eligibility', 'أهلية الإرجاع')}
            </h2>
            <p className="mt-2 text-muted-foreground">
              {t(
                'To be eligible for a return, items must be:',
                'لتكون مؤهلاً للإرجاع، يجب أن تكون العناصر:'
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
                  {t('Unused and in original condition', 'غير مستخدمة وبحالتها الأصلية')}
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
                    'في العبوة الأصلية مع جميع البطاقات'
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
                    'مرفقة بالإيصال الأصلي أو إثبات الشراء'
                  )}
                </span>
              </li>
            </ul>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t('How to Return an Item', 'كيفية إرجاع منتج')}
            </h2>
            <div className="mt-4 space-y-4">
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  1
                </div>
                <div>
                  <h3 className="font-medium text-foreground">{t('Contact Us', 'تواصل معنا')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      `Email us at ${returnsEmail} with your order number and reason for return.`,
                      `راسلنا على ${returnsEmail} مع رقم طلبك وسبب الإرجاع.`
                    )}
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  2
                </div>
                <div>
                  <h3 className="font-medium text-foreground">
                    {t('Get Return Label', 'الحصول على ملصق الإرجاع')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "We'll send you a prepaid return shipping label via email.",
                      'سنرسل لك ملصق شحن إرجاع مدفوع مسبقاً عبر البريد الإلكتروني.'
                    )}
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  3
                </div>
                <div>
                  <h3 className="font-medium text-foreground">
                    {t('Ship the Item', 'شحن المنتج')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'Pack the item securely and drop it off at any authorized shipping location.',
                      'قم بتغليف المنتج بشكل آمن وتسليمه في أي موقع شحن معتمد.'
                    )}
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  4
                </div>
                <div>
                  <h3 className="font-medium text-foreground">
                    {t('Receive Refund', 'استلام المبلغ المسترد')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "Once we receive and inspect the item, we'll process your refund within 5-7 business days.",
                      'بمجرد استلام المنتج وفحصه، سنقوم بمعالجة استرداد المبلغ خلال 5-7 أيام عمل.'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t('Refund Information', 'معلومات الاسترداد')}
            </h2>
            <ul className="mt-4 space-y-2 text-muted-foreground">
              <li>
                {t(
                  'Refunds will be credited to your original payment method',
                  'سيتم إرجاع المبلغ إلى طريقة الدفع الأصلية'
                )}
              </li>
              <li>
                {t(
                  'Please allow 5-7 business days for the refund to appear',
                  'يرجى الانتظار 5-7 أيام عمل لظهور المبلغ المسترد'
                )}
              </li>
              <li>
                {t(
                  'Original shipping costs are non-refundable (unless the item was defective)',
                  'تكاليف الشحن الأصلية غير قابلة للاسترداد (ما لم يكن المنتج معيباً)'
                )}
              </li>
              <li>
                {t(
                  'Sale items are final sale and cannot be returned',
                  'العناصر المخفضة نهائية ولا يمكن إرجاعها'
                )}
              </li>
            </ul>
          </section>

          {/* Return Request Form */}
          {store.id && store.id !== 'demo' && <ReturnRequestForm storeId={store.id} />}
        </div>

        <div className="mt-8 text-center">
          <p className="text-muted-foreground">
            {t('Need help with a return?', 'هل تحتاج مساعدة في الإرجاع؟')}{' '}
            <Link href={storeUrl('/contact')} className="text-primary hover:underline">
              {t('Contact our support team', 'تواصل مع فريق الدعم')}
            </Link>
          </p>
        </div>
      </div>

      <Footer />
    </main>
  );
}
