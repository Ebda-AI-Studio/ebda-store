'use client';

import { storeNumerals } from '@force/shared';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@force/ui';
import { api } from '@/lib/api';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useLocalePrice } from '../../../hooks/useLocalePrice';
import { formatDate } from '@/lib/format-date';
import { useStore } from '../../../contexts/StoreContext';
import type { InstapayInstructions } from '@force/shared';

interface InstapayView {
  orderStatus: string;
  paymentStatus: string;
  instructions: InstapayInstructions;
}

/**
 * The InstaPay manual-transfer instructions (SP6a): who to pay (the merchant's
 * handle / phone), the EXACT amount, the order reference to quote, the deadline,
 * and a place for the customer to enter the transfer reference. The merchant
 * confirms the transfer on their side; this card polls and reflects it.
 */
export function InstapayCard({
  orderId,
  onStatus,
}: {
  orderId: string;
  /** Reports the order status so the page headline follows it. */
  onStatus?: (status: 'awaiting' | 'paid' | 'cancelled') => void;
}) {
  const { t, language } = useLanguage();
  const formatPrice = useLocalePrice();
  const { store } = useStore();
  const [view, setView] = useState<InstapayView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<InstapayView>(`/payments/instapay/${orderId}`);
      if (res.success && res.data) {
        setView(res.data);
        setLoadError(false);
        const s = res.data.orderStatus;
        onStatus?.(
          s === 'cancelled'
            ? 'cancelled'
            : s === 'awaiting_payment_confirmation'
              ? 'awaiting'
              : 'paid'
        );
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    }
  }, [orderId, onStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the merchant has not confirmed, look again every 30 s.
  const awaiting = view?.orderStatus === 'awaiting_payment_confirmation';
  useEffect(() => {
    if (!awaiting) return;
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [awaiting, load]);

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(c => (c === key ? null : c)), 1500);
    } catch {
      // Clipboard unavailable: the value is on screen to type.
    }
  }

  async function submitReference() {
    setSaving(true);
    setRefError(null);
    try {
      const res = await api.post(`/payments/instapay/${orderId}/reference`, { reference });
      if (res.success) {
        setSaved(true);
        await load();
      } else {
        setRefError(
          t(
            'Could not save the reference. Use letters, digits and - _ . / # only.',
            'تعذّر حفظ المرجع. استخدم أحرفاً وأرقاماً و - _ . / # فقط.'
          )
        );
      }
    } catch {
      setRefError(t('Could not save the reference.', 'تعذّر حفظ المرجع.'));
    } finally {
      setSaving(false);
    }
  }

  if (loadError && !view) {
    return (
      <p className="mt-6 text-sm text-muted-foreground" data-testid="instapay-load-error">
        {t(
          'We could not load the transfer details. Please refresh this page.',
          'تعذّر تحميل تفاصيل التحويل. يرجى تحديث الصفحة.'
        )}
      </p>
    );
  }
  if (!view) return null;
  const ins = view.instructions;
  const cancelled = view.orderStatus === 'cancelled';
  const confirmed = !awaiting && !cancelled;

  const row = (key: string, label: string, value: string | undefined) =>
    value ? (
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="break-all font-medium text-foreground" dir="ltr">
            {value}
          </p>
        </div>
        <Button variant="outline" size="sm" type="button" onClick={() => void copy(key, value)}>
          {copied === key ? t('Copied', 'تم النسخ') : t('Copy', 'نسخ')}
        </Button>
      </div>
    ) : null;

  return (
    <section
      className="mt-6 rounded-xl border bg-card p-5 text-start shadow-sm"
      data-testid="instapay-card"
      aria-label={t('InstaPay transfer details', 'تفاصيل تحويل إنستاباي')}
    >
      <h2 className="text-lg font-semibold text-foreground">
        {confirmed
          ? t('Transfer confirmed', 'تم تأكيد التحويل')
          : cancelled
            ? t('This order expired', 'انتهت مهلة هذا الطلب')
            : t('Pay by InstaPay', 'ادفع عبر إنستاباي')}
      </h2>

      {awaiting && (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              'Transfer exactly this amount, then keep your order number in the transfer note. The store confirms your order once the money arrives.',
              'حوّل هذا المبلغ بالضبط، واكتب رقم الطلب في ملاحظة التحويل. يؤكد المتجر طلبك فور وصول المبلغ.'
            )}
          </p>
          <div className="mt-3 divide-y rounded-lg border px-3">
            {row('amount', t('Amount to transfer', 'المبلغ المطلوب'), formatPrice(ins.amountMinor))}
            {row('handle', t('InstaPay address', 'عنوان إنستاباي'), ins.handle)}
            {row('phone', t('Or to this mobile number', 'أو إلى رقم الموبايل'), ins.phone)}
            {ins.accountName && (
              <div className="py-2">
                <p className="text-xs text-muted-foreground">{t('Account name', 'اسم الحساب')}</p>
                <p className="font-medium text-foreground">{ins.accountName}</p>
              </div>
            )}
            {row(
              'reference',
              t('Order number (put it in the note)', 'رقم الطلب (اكتبه في الملاحظة)'),
              ins.reference
            )}
          </div>
          <p className="mt-3 text-sm text-warning-ink">
            {t('Pay before', 'ادفع قبل')}{' '}
            {formatDate(ins.expiresAt, {
              timezone: store.timezone,
              language,
              numerals: storeNumerals(store?.theme),
              style: 'short',
            })}
            {t(
              '. After that the order is cancelled and the items go back on sale.',
              '. بعدها يُلغى الطلب وتعود المنتجات للبيع.'
            )}
          </p>

          <div className="mt-4">
            <label className="text-sm font-medium text-foreground" htmlFor="instapay-ref">
              {t('Transfer reference (optional)', 'مرجع التحويل (اختياري)')}
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="instapay-ref"
                value={reference}
                onChange={e => setReference(e.target.value)}
                maxLength={64}
                dir="ltr"
                className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
                placeholder={ins.customerReference ?? 'IPN 1234 5678'}
              />
              <Button
                type="button"
                onClick={() => void submitReference()}
                disabled={saving || reference.trim().length < 3}
              >
                {t('Send', 'إرسال')}
              </Button>
            </div>
            {(saved || ins.customerReference) && !refError && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('Saved', 'تم الحفظ')}:{' '}
                <span dir="ltr">{ins.customerReference ?? reference}</span>
              </p>
            )}
            {refError && <p className="mt-1 text-xs text-destructive-ink">{refError}</p>}
          </div>
        </>
      )}

      {confirmed && (
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'The store confirmed your transfer. Your order is on its way to being prepared.',
            'أكّد المتجر استلام التحويل. طلبك قيد التجهيز.'
          )}
        </p>
      )}
      {cancelled && (
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'No transfer was confirmed in time, so the order was cancelled. You can place it again.',
            'لم يُؤكَّد أي تحويل في الوقت المحدد، لذلك أُلغي الطلب. يمكنك تقديمه من جديد.'
          )}
        </p>
      )}
    </section>
  );
}
