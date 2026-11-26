'use client';

import { useState } from 'react';
import { Button } from '@ebda/ui';
import { useLanguage } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';

/**
 * A guest's return request: order number plus the phone OR email left at checkout (Foundation criterion 19,
 * Ruling GUEST-RET-1). The API answers every identity failure with one identical body, so this form shows one
 * message for it too and never says which field was wrong. No lines are chosen: the whole order is requested and
 * the merchant reviews it. A request moves no money.
 */
const REASONS = [
  ['defective', 'Item is defective or damaged', 'المنتج معيب أو تالف'],
  ['wrong_item', 'Wrong item received', 'وصلني منتج غلط'],
  ['not_as_described', 'Not as described', 'لا يطابق الوصف'],
  ['changed_mind', 'Changed my mind', 'غيرت رأيي'],
  ['other', 'Other', 'أخرى'],
] as const;

export default function GuestReturnForm() {
  const { t, language } = useLanguage();
  const [orderNumber, setOrderNumber] = useState('');
  const [contact, setContact] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!orderNumber.trim() || !contact.trim() || !reason) {
      setError(t('Please fill in every field.', 'املأ كل الخانات.'));
      return;
    }
    const isEmail = contact.includes('@');
    setBusy(true);
    try {
      const json = await api.post<{ returnNumber?: string }>('/public/returns/guest', {
        orderNumber: orderNumber.trim(),
        ...(isEmail ? { email: contact.trim() } : { phone: contact.trim() }),
        type: 'return',
        reason,
      });
      if (json.success) {
        setDone(json.data?.returnNumber ?? '');
        return;
      }
      const code = json.error?.code;
      setError(
        code === 'GUEST_RETURN_NOT_FOUND'
          ? t(
              'We could not find an order matching those details. Check them and try again.',
              'ملقيناش طلب بالبيانات دي. راجعها وجرّب تاني.'
            )
          : code === 'RATE_LIMITED'
            ? t(
                'Too many attempts. Please try again in a few minutes.',
                'محاولات كتير. جرّب تاني بعد دقايق.'
              )
            : code === 'RETURN_WINDOW_CLOSED'
              ? t(
                  'The return period for this order has ended. Please contact the store.',
                  'مدة الإرجاع للطلب ده خلصت. كلّم المتجر.'
                )
              : t(
                  'This order is not eligible for a return request.',
                  'الطلب ده مينفعش يتقدم له طلب إرجاع.'
                )
      );
    } catch {
      setError(
        t(
          'Failed to submit return request. Please check your connection.',
          'طلب الإرجاع متبعتش. اتأكد من اتصالك.'
        )
      );
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <div role="status" className="mt-4 rounded-lg border bg-card p-4 text-center">
        <p className="font-semibold text-foreground">
          {t('Return request submitted', 'طلب الإرجاع اتبعت')}
        </p>
        {done && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Return number:', 'رقم الإرجاع:')}{' '}
            <span dir="ltr" className="font-mono font-semibold text-foreground">
              #{done}
            </span>
          </p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          {t('We will review your request and contact you shortly.', 'هنراجع طلبك ونكلّمك قريب.')}
        </p>
      </div>
    );
  }

  const field = 'mt-1 w-full rounded-md border bg-background px-3 py-2 text-base text-foreground';
  return (
    <form onSubmit={submit} className="mt-6 space-y-4 border-t pt-6" noValidate>
      <h3 className="font-semibold text-foreground">
        {t('Ordered without an account?', 'طلبت من غير حساب؟')}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t(
          'Enter your order number and the phone number or email you used at checkout. We will request a return for the whole order.',
          'اكتب رقم طلبك ورقم الموبايل أو الإيميل اللي استخدمته وقت الطلب. هنقدّم طلب إرجاع للطلب كله.'
        )}
      </p>
      <label className="block text-sm font-medium text-foreground">
        {t('Order number', 'رقم الطلب')}
        <input
          className={field}
          dir="ltr"
          value={orderNumber}
          onChange={e => setOrderNumber(e.target.value)}
          autoComplete="off"
          maxLength={64}
        />
      </label>
      <label className="block text-sm font-medium text-foreground">
        {t('Phone or email used at checkout', 'رقم الموبايل أو الإيميل اللي استخدمته في الطلب')}
        <input
          className={field}
          dir="ltr"
          value={contact}
          onChange={e => setContact(e.target.value)}
          autoComplete="off"
          maxLength={254}
        />
      </label>
      <label className="block text-sm font-medium text-foreground">
        {t('Reason', 'السبب')}
        <select className={field} value={reason} onChange={e => setReason(e.target.value)}>
          <option value="">{t('Select a reason', 'اختار السبب')}</option>
          {REASONS.map(([value, en, ar]) => (
            <option key={value} value={value}>
              {language === 'ar' ? ar : en}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive-ink">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? t('Submitting...', 'بيتبعت...') : t('Request a return', 'اطلب إرجاع')}
      </Button>
    </form>
  );
}
