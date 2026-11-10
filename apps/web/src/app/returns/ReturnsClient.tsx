'use client';

import { signedText } from '@/lib/bidi';
import { useState, useEffect } from 'react';
import Link from '../../components/StoreLink';
import { Button, Select } from '@ebda/ui';
import { ShopChrome } from '../../components';
import { useStoreContact, useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useAuth } from '../../contexts/AuthContext';
import { api, API_URL, type Order } from '../../lib/api';
import { groupOrderLinesForDisplay } from '@ebda/shared';
import { returnPolicyCopy, returnPolicyKind } from '../../lib/return-policy-text';
import { useNumerals } from '../../hooks/useNumerals';

const RETURN_REASONS = [
  {
    value: 'defective',
    label: 'Item is defective or damaged',
    labelAr: 'المنتج معيب أو تالف',
  },
  {
    value: 'wrong_item',
    label: 'Wrong item received',
    labelAr: 'وصلني منتج غلط',
  },
  {
    value: 'not_as_described',
    label: 'Not as described',
    labelAr: 'لا يطابق الوصف',
  },
  {
    value: 'changed_mind',
    label: 'Changed my mind',
    labelAr: 'غيرت رأيي',
  },
  { value: 'other', label: 'Other', labelAr: 'أخرى' },
] as const;

type ReturnReason = (typeof RETURN_REASONS)[number]['value'];

/**
 * Fetch with auth cookie attached. READ-ONLY use only — it sends no
 * X-Session-ID / X-CSRF-Token, so any state-changing call must go through the
 * ApiClient (`api.post` etc.) instead or csrfProtection 403s it on every
 * merchant custom domain (only the platform origin is CSRF-exempt).
 */
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
  // AuthContext owns the "who is this?" question. This form used to ask `/auth/me` a second time
  // on its own: a second red 401 in a guest's console, and a customer whose 30-minute access token
  // had lapsed was shown the signed-out state, because a raw fetch never refreshes.
  const { isAuthenticated: isLoggedIn } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  // Bundle boxes are selected as ONE unit — this holds `bundleGroupId`s,
  // never individual component `orderItemId`s. The route accepts
  // `bundleGroupIds: string[]` (Task 7) precisely so a box never has to be
  // expressed as its components.
  const [selectedBundleGroupIds, setSelectedBundleGroupIds] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<ReturnReason | ''>('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    type: 'success' | 'error';
    text: string;
    returnNumber?: string;
  } | null>(null);

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
  // Collapses every component line of a bundle box into ONE selectable
  // row (see groupOrderLinesForDisplay) — a customer ticks the box, never
  // one of its components. Non-bundle lines pass through unchanged and
  // stay individually selectable exactly as before.
  const displayRows = selectedOrder ? groupOrderLinesForDisplay(selectedOrder.items) : [];

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

  function toggleBundleGroup(bundleGroupId: string) {
    setSelectedBundleGroupIds(prev => {
      const next = new Set(prev);
      if (next.has(bundleGroupId)) {
        next.delete(bundleGroupId);
      } else {
        next.add(bundleGroupId);
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
        text: t('Please select an order.', 'اختار طلب.'),
      });
      return;
    }
    if (selectedItemIds.size === 0 && selectedBundleGroupIds.size === 0) {
      setSubmitResult({
        type: 'error',
        text: t(
          'Please select at least one item to return.',
          'اختار حاجة واحدة على الأقل ترجّعها.'
        ),
      });
      return;
    }
    if (!reason) {
      setSubmitResult({
        type: 'error',
        text: t('Please select a return reason.', 'اختار سبب الإرجاع.'),
      });
      return;
    }

    // Build the full item objects the API's createReturnSchema requires
    // (orderItemId + productId + productName + quantity) from the selected
    // order's line items. Sending only { orderItemId } — as this form used to —
    // fails Zod validation server-side, so the request never created a return.
    // `selectedItemIds` only ever holds NON-bundle order item ids — a
    // bundle box's components are never offered as individually tickable
    // (see the "Select Items to Return" block below) — so the
    // `!it.bundleGroupId` filter here is defensive, not load-bearing.
    const items = (selectedOrder?.items ?? [])
      .filter(it => selectedItemIds.has(it.id) && !it.bundleGroupId)
      .map(it => ({
        orderItemId: it.id,
        productId: it.productId,
        productName: it.product?.name ?? '',
        quantity: it.quantity,
      }));
    // One id per BOX — selecting a bundle box submits its bundleGroupId,
    // never the component orderItemIds inside it (the route refuses those
    // with `bundle_returns_are_atomic` — see return.service.ts).
    const bundleGroupIds = Array.from(selectedBundleGroupIds);

    if (items.length === 0 && bundleGroupIds.length === 0) {
      setSubmitResult({
        type: 'error',
        text: t(
          'Please select at least one item to return.',
          'اختار حاجة واحدة على الأقل ترجّعها.'
        ),
      });
      return;
    }

    setIsSubmitting(true);
    try {
      // Must go through the ApiClient, not authFetch: this is a state-changing
      // request on a non-/public/ path, so csrfProtection requires X-Session-ID
      // + X-CSRF-Token. A raw fetch 403s CSRF_MISSING_SESSION on every merchant
      // custom domain (the platform origin is exempt, so it looks fine there).
      // `items`/`bundleGroupIds` are only included when non-empty — the
      // route's Zod schema has `.min(1)` on a PRESENT `bundleGroupIds`, so
      // sending `[]` (rather than omitting the key) would 400 a return
      // that is entirely bundle boxes.
      const json = await api.post<{ return?: { returnNumber?: string } }>(
        `/stores/${storeId}/returns`,
        {
          orderId: selectedOrderId,
          type: 'return',
          ...(items.length > 0 ? { items } : {}),
          ...(bundleGroupIds.length > 0 ? { bundleGroupIds } : {}),
          reason,
          customerNotes: notes.trim() || undefined,
        }
      );

      if (json.success) {
        const returnNumber = json.data?.return?.returnNumber;
        setSubmitResult({
          type: 'success',
          text: t('Your return request has been submitted successfully.', 'طلب الإرجاع اتبعت.'),
          returnNumber,
        });
        // Reset form
        setSelectedOrderId('');
        setSelectedItemIds(new Set());
        setSelectedBundleGroupIds(new Set());
        setReason('');
        setNotes('');
      } else {
        // The ApiClient turns transport failures into a result rather than a
        // throw, so keep the localized connection copy for those codes.
        const transportFailure =
          json.error?.code === 'NETWORK_ERROR' || json.error?.code === 'TIMEOUT';
        // A merchant is completing another return on this order right now.
        const orderBusy = json.error?.code === 'RETURN_ORDER_BUSY';
        // Outside the store's published return window (or returns switched off).
        const windowClosed = json.error?.code === 'RETURN_WINDOW_CLOSED';
        setSubmitResult({
          type: 'error',
          text: windowClosed
            ? t(
                'The return period for this order has ended, so a return can no longer be requested online. Please contact the store.',
                'مدة الإرجاع للطلب ده خلصت ومبقاش ينفع تقدّم طلب إرجاع أونلاين. كلّم المتجر.'
              )
            : orderBusy
              ? t(
                  'Another return on this order is being processed. Please try again in a moment.',
                  'في إرجاع تاني للطلب ده بيتجهز دلوقتي. جرّب تاني بعد شوية.'
                )
              : transportFailure
                ? t(
                    'Failed to submit return request. Please check your connection.',
                    'طلب الإرجاع متبعتش. اتأكد من اتصالك.'
                  )
                : json.error?.message ||
                  t(
                    'Failed to submit return request. Please try again.',
                    'طلب الإرجاع متبعتش. جرّب تاني.'
                  ),
        });
      }
    } catch {
      setSubmitResult({
        type: 'error',
        text: t(
          'Failed to submit return request. Please check your connection.',
          'طلب الإرجاع متبعتش. اتأكد من اتصالك.'
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
          {t('Request a Return', 'طلب إرجاع')}
        </h2>
        <p className="mt-3 text-muted-foreground">
          <Link
            href={`${storeUrl('/auth/login')}?redirect=${encodeURIComponent('/returns')}`}
            className="font-medium text-primary hover:underline"
          >
            {t('Log in', 'تسجيل الدخول')}
          </Link>{' '}
          {t(
            'to submit a return request for one of your orders.',
            'عشان تقدّم طلب إرجاع لطلب من طلباتك.'
          )}
        </p>
      </section>
    );
  }

  if (submitResult?.type === 'success') {
    return (
      <section className="rounded-xl border bg-card p-8 shadow-sm text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/20">
          <svg
            className="h-7 w-7 text-success-ink"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="mt-4 text-xl font-semibold text-foreground">
          {t('Return Request Submitted', 'طلب الإرجاع اتبعت')}
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
          {t('We will review your request and contact you shortly.', 'هنراجع طلبك ونكلّمك قريب.')}
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
    <section className="rounded-xl border bg-card p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-foreground">
        {t('Request a Return', 'طلب إرجاع')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          'Fill out the form below to start a return for a delivered order.',
          'املا الفورم اللي تحت عشان تبدأ ترجّع طلب وصلك.'
        )}
      </p>

      {submitResult?.type === 'error' && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive-ink">
          {submitResult.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="return-order" className="block text-sm font-medium text-foreground mb-1">
            {t('Select Order', 'اختر الطلب')} <span className="text-destructive-ink">*</span>
          </label>
          {isLoadingOrders ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              {t('Loading your orders...', 'بنحمّل طلباتك...')}
            </div>
          ) : (
            <Select
              id="return-order"
              value={selectedOrderId}
              onChange={e => {
                setSelectedOrderId(e.target.value);
                setSelectedItemIds(new Set());
                setSelectedBundleGroupIds(new Set());
              }}
              required
              options={[
                {
                  value: '',
                  label: t('-- Select an order --', '-- اختر طلباً --'),
                },
                ...orders.map(order => {
                  // Collapse to display rows first — a box's own component
                  // count must not inflate "(+N more)" past what the
                  // customer actually bought (e.g. one 3-component bundle
                  // must read as one line, not "+2 more").
                  const rows = groupOrderLinesForDisplay(order.items);
                  const first = rows[0];
                  const firstName =
                    first?.kind === 'bundle' ? first.name : first?.item.product?.name;
                  return {
                    value: order.id,
                    label: `#${order.orderNumber}${
                      firstName
                        ? ` — ${firstName}${rows.length > 1 ? ` (${t(`${signedText('+', rows.length - 1)} more`, `${signedText('+', rows.length - 1)} أخرى`)})` : ''}`
                        : ''
                    }`,
                  };
                }),
              ]}
              className="w-full rounded-lg border border-input px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          )}
          {!isLoadingOrders && orders.length === 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'No eligible orders found. Only delivered orders can be returned.',
                'ملقيناش طلبات ينفع ترجّعها. ينفع ترجّع الطلبات اللي اتسلّمت بس.'
              )}
            </p>
          )}
        </div>

        {selectedOrder && displayRows.length > 0 && (
          <div>
            <p className="block text-sm font-medium text-foreground mb-2">
              {t('Select Items to Return', 'اختر العناصر للإرجاع')}{' '}
              <span className="text-destructive-ink">*</span>
            </p>
            <div className="space-y-2">
              {displayRows.map(row =>
                row.kind === 'bundle' ? (
                  // A bundle box is ONE selectable unit — ticking it submits
                  // its bundleGroupId, never the component orderItemIds
                  // inside it. Individual components of a box are never
                  // offered here (see `groupOrderLinesForDisplay`).
                  <label
                    key={row.key}
                    className="flex items-center gap-3 rounded-lg border border-input px-4 py-3 cursor-pointer hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selectedBundleGroupIds.has(row.bundleGroupId)}
                      onChange={() => toggleBundleGroup(row.bundleGroupId)}
                      className="h-6 w-6 rounded border-input text-primary focus:ring-primary"
                    />
                    <span className="flex-1 text-sm text-foreground">
                      {row.name}
                      <span className="ms-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {t('Whole box', 'الصندوق كاملاً')}
                      </span>
                    </span>
                  </label>
                ) : (
                  <label
                    key={row.key}
                    className="flex items-center gap-3 rounded-lg border border-input px-4 py-3 cursor-pointer hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selectedItemIds.has(row.item.id)}
                      onChange={() => toggleItem(row.item.id)}
                      className="h-6 w-6 rounded border-input text-primary focus:ring-primary"
                    />
                    <span className="flex-1 text-sm text-foreground">
                      {row.item.product?.name || `Item #${row.item.id.slice(0, 8)}`}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t('Qty', 'الكمية')}: {row.item.quantity}
                    </span>
                  </label>
                )
              )}
            </div>
            {displayRows.some(row => row.kind === 'bundle') && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  "A bundle box is returned as a whole — its components can't be selected individually.",
                  'الصندوق بيرجع كله — مينفعش تختار مكوناته لوحدها.'
                )}
              </p>
            )}
          </div>
        )}

        <div>
          <Select
            id="return-reason"
            label={`${t('Reason for Return', 'سبب الإرجاع')} *`}
            value={reason}
            onChange={e => setReason(e.target.value as ReturnReason)}
            required
            options={[
              {
                value: '',
                label: t('-- Select a reason --', '-- اختر سبباً --'),
              },
              ...RETURN_REASONS.map(r => ({ value: r.value, label: t(r.label, r.labelAr) })),
            ]}
            className="w-full rounded-lg border border-input px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <div>
          <label htmlFor="return-notes" className="block text-sm font-medium text-foreground mb-1">
            {t('Additional Notes (optional)', 'ملاحظات إضافية (اختياري)')}
          </label>
          <textarea
            id="return-notes"
            rows={4}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={t('Describe the issue in more detail...', 'اوصف المشكلة بتفاصيل أكتر...')}
            className="w-full rounded-lg border border-input px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none sm:text-sm"
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

export default function ReturnsClient() {
  const { email } = useStoreContact();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t, language } = useLanguage();
  // Days in the store's digits, the same as the PDP trust line (review M8).
  const { localize } = useNumerals();
  const policy = returnPolicyCopy(store.returnWindowDays, language, localize);
  const returnsEmail = email || t('our support team', 'فريق الدعم');
  return (
    <ShopChrome>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-foreground">
            {t('Returns & Refunds', 'المرتجعات واسترداد الفلوس')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t('Our hassle-free return policy', 'سياسة إرجاع سهلة')}
          </p>
        </div>

        <div className="mt-12 space-y-8">
          {/* legal-register:start — the returns-policy body stays formal (Ruling FU46-Y02b) */}
          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/20">
                <svg
                  className="h-5 w-5 text-success-ink"
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
              <h2 className="text-xl font-semibold text-foreground">{policy.title}</h2>
            </div>
            <p className="mt-4 text-muted-foreground">{policy.body}</p>
          </section>

          <section className="rounded-xl border bg-card p-6 shadow-sm">
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

          <section className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">
              {t('How to Return an Item', 'كيفية إرجاع منتج')}
            </h2>
            <div className="mt-4 space-y-4">
              {[
                {
                  step: '1',
                  title: t('Contact Us', 'تواصل معنا'),
                  desc: t(
                    `Email us at ${returnsEmail} with your order number and reason for return.`,
                    `راسلنا على ${returnsEmail} مع رقم طلبك وسبب الإرجاع.`
                  ),
                },
                {
                  step: '2',
                  title: t('Get Return Label', 'الحصول على ملصق الإرجاع'),
                  desc: t(
                    "We'll send you a prepaid return shipping label via email.",
                    'سنرسل لك ملصق شحن إرجاع مدفوع مسبقاً عبر البريد الإلكتروني.'
                  ),
                },
                {
                  step: '3',
                  title: t('Ship the Item', 'شحن المنتج'),
                  desc: t(
                    'Pack the item securely and drop it off at any authorized shipping location.',
                    'قم بتغليف المنتج بشكل آمن وتسليمه في أي موقع شحن معتمد.'
                  ),
                },
                {
                  step: '4',
                  title: t('Receive Refund', 'استلام المبلغ المسترد'),
                  desc: t(
                    "Once we receive and inspect the item, we'll process your refund.",
                    'بمجرد استلام المنتج وفحصه، سنقوم بمعالجة استرداد المبلغ.'
                  ),
                },
              ].map(({ step, title, desc }) => (
                <div key={step} className="flex gap-4">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
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
                  'Refund timing depends on your payment method and bank',
                  'يختلف موعد ظهور المبلغ المسترد حسب وسيلة الدفع والبنك'
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

          {/* legal-register:end */}
          {/* Return Request Form */}
          {store.id &&
            store.id !== 'demo' &&
            returnPolicyKind(store.returnWindowDays) !== 'none' && (
              <ReturnRequestForm storeId={store.id} />
            )}
        </div>

        <div className="mt-8 text-center">
          <p className="text-muted-foreground">
            {t('Need help with a return?', 'محتاج مساعدة في الإرجاع؟')}{' '}
            <Link href={storeUrl('/contact')} className="text-primary hover:underline">
              {t('Contact our support team', 'تواصل مع فريق الدعم')}
            </Link>
          </p>
        </div>
      </div>
    </ShopChrome>
  );
}
