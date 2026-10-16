'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  INSTAPAY_RECEIPT_MAX_BYTES,
  INSTAPAY_RECEIPT_MIME_TYPES,
  normalizeInstapayReference,
  toAsciiDigits,
  tryToMinor,
} from '@ebda/shared';
import type { InstapayReceiptView } from '@ebda/shared';
import { Button } from '@ebda/ui';
import { api } from '@/lib/api';
import { useLanguage } from '../../../contexts/LanguageContext';

export interface InstapayProof {
  receiptId: string;
  status: 'submitted' | 'approved' | 'rejected' | 'voided';
  reviewNote: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
}

const POLL_MS = 2000;
const MAX_POLLS = 15; // ~30 s, then manual entry

interface FormState {
  amount: string;
  reference: string;
  transferDate: string;
  transferTime: string;
  payerName: string;
  payerAddress: string;
  payerMobile: string;
  payerBank: string;
  receiverName: string;
  receiverHandle: string;
  receiverMobile: string;
  note: string;
}

const EMPTY: FormState = {
  amount: '',
  reference: '',
  transferDate: '',
  transferTime: '',
  payerName: '',
  payerAddress: '',
  payerMobile: '',
  payerBank: '',
  receiverName: '',
  receiverHandle: '',
  receiverMobile: '',
  note: '',
};

function prefill(r: InstapayReceiptView | null): FormState {
  const x = r?.extractionStatus === 'done' ? r.extracted : null;
  if (!x) return EMPTY;
  return {
    amount: x.amountMinor ? (x.amountMinor / 100).toFixed(2) : '',
    reference: x.reference ?? '',
    transferDate: x.transferDate ?? '',
    transferTime: x.transferTime ?? '',
    payerName: x.payerName ?? '',
    payerAddress: x.payerAddress ?? '',
    payerMobile: x.payerMobile ?? '',
    payerBank: x.payerBank ?? '',
    receiverName: x.receiverName ?? '',
    receiverHandle: x.receiverHandle ?? '',
    receiverMobile: x.receiverMobile ?? '',
    note: x.note ?? '',
  };
}

/**
 * The shopper's receipt flow: upload the transfer screenshot, check the details the
 * system read from it, send. The STORE OWNER reviews it; nothing is confirmed here.
 */
export function InstapayReceiptUploader({
  orderId,
  proof,
  onSubmitted,
}: {
  orderId: string;
  proof: InstapayProof | null;
  /** Called once the receipt is sent, so the card reloads the order view. */
  onSubmitted: () => void;
}) {
  const { t } = useLanguage();
  const [receipt, setReceipt] = useState<InstapayReceiptView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [uploading, setUploading] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polls = useRef(0);
  const prefilledFor = useRef<string | null>(null);

  const base = `/payments/instapay/${orderId}/receipt`;

  const errorCopy = useCallback(
    (code: string | undefined): string => {
      switch (code) {
        case 'DUPLICATE_REFERENCE':
          return t(
            'This transfer reference was already used for another payment. Check the reference, or contact the store.',
            'مرجع التحويل ده اتستخدم قبل كده في دفعة تانية. راجع المرجع أو كلّم المتجر.'
          );
        case 'INVALID_FILE_TYPE':
          return t(
            'Please upload a JPG, PNG or WebP image.',
            'ارفع صورة بصيغة JPG أو PNG أو WebP.'
          );
        case 'FILE_TOO_LARGE':
          return t('The image is larger than 8 MB.', 'حجم الصورة أكبر من 8 ميجا.');
        case 'TOO_MANY_RECEIPTS':
        case 'RATE_LIMITED':
          return t(
            'Too many attempts. Please wait a few minutes and try again.',
            'محاولات كتير. استنى كام دقيقة وجرّب تاني.'
          );
        case 'PRIVATE_STORAGE_NOT_CONFIGURED':
          return t(
            'Receipt upload is not available for this store right now. Please contact the store.',
            'رفع الإيصال مش متاح للمتجر ده دلوقتي. كلّم المتجر.'
          );
        default:
          return t('Something went wrong. Please try again.', 'حصل خطأ. جرّب تاني.');
      }
    },
    [t]
  );

  // Poll the AI read until it settles (or give up and let the shopper type it).
  const receiptId = receipt?.id;
  const pending = receipt?.extractionStatus === 'pending' && !timedOut;
  useEffect(() => {
    if (!receiptId || !pending) return;
    const timer = setTimeout(async () => {
      polls.current += 1;
      try {
        const res = await api.get<{ receipt: InstapayReceiptView }>(`${base}/${receiptId}`);
        if (res.success && res.data?.receipt) setReceipt(res.data.receipt);
      } catch {
        // Network blip: the next tick retries until the cap.
      }
      if (polls.current >= MAX_POLLS) setTimedOut(true);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [receiptId, pending, base, receipt]);

  // Fill the form once, when the read settles.
  useEffect(() => {
    if (!receipt || receipt.extractionStatus === 'pending') return;
    if (prefilledFor.current === receipt.id) return;
    prefilledFor.current = receipt.id;
    setForm(prefill(receipt));
  }, [receipt]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!(INSTAPAY_RECEIPT_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(errorCopy('INVALID_FILE_TYPE'));
      return;
    }
    if (file.size > INSTAPAY_RECEIPT_MAX_BYTES) {
      setError(errorCopy('FILE_TOO_LARGE'));
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await api.postForm<{ receipt: InstapayReceiptView }>(base, body);
      if (res.success && res.data?.receipt) {
        polls.current = 0;
        prefilledFor.current = null;
        setTimedOut(false);
        setReceipt(res.data.receipt);
      } else {
        setError(errorCopy(res.error?.code));
      }
    } catch {
      setError(errorCopy(undefined));
    } finally {
      setUploading(false);
    }
  }

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!receipt) return;
    setError(null);
    const amountMinor = tryToMinor(toAsciiDigits(form.amount).replace(/[\s,]/g, ''));
    const reference = normalizeInstapayReference(form.reference);
    if (!amountMinor || amountMinor <= 0 || !reference) {
      setError(
        t(
          'Check the amount and the transfer reference (8 to 20 digits).',
          'راجع المبلغ ومرجع التحويل (من 8 لـ 20 رقم).'
        )
      );
      return;
    }
    if (!form.transferDate || !form.transferTime || !form.payerName.trim()) {
      setError(
        t(
          'Fill in the date, time and the sender name as shown on the receipt.',
          'املا التاريخ والوقت واسم المُحوِّل زي ما هو مكتوب في الإيصال.'
        )
      );
      return;
    }
    const opt = (v: string) => (v.trim() ? v.trim() : null);
    setSubmitting(true);
    try {
      const res = await api.post<{ receipt: InstapayReceiptView }>(`${base}/${receipt.id}/submit`, {
        amountMinor,
        reference,
        transferDate: form.transferDate,
        transferTime: form.transferTime,
        payerName: form.payerName.trim(),
        payerAddress: opt(form.payerAddress),
        payerMobile: opt(form.payerMobile),
        payerBank: opt(form.payerBank),
        receiverName: opt(form.receiverName),
        receiverHandle: opt(form.receiverHandle),
        receiverMobile: opt(form.receiverMobile),
        note: opt(form.note),
      });
      if (res.success) {
        setSent(true);
        setReceipt(null);
        onSubmitted();
      } else {
        setError(errorCopy(res.error?.code));
      }
    } catch {
      setError(errorCopy(undefined));
    } finally {
      setSubmitting(false);
    }
  }

  const reviewing = sent || proof?.status === 'submitted';
  if (reviewing) {
    return (
      <div className="mt-4 rounded-lg border bg-muted/40 p-3" data-testid="instapay-review-notice">
        <p className="text-sm font-medium text-foreground">
          {t('Your receipt was sent.', 'الإيصال اتبعت.')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('The store owner will review your transfer.', 'صاحب المتجر هيراجع التحويل')}
        </p>
      </div>
    );
  }

  const field = (key: keyof FormState, label: string, opts?: { type?: string; dir?: 'ltr' }) => (
    <div>
      <label className="text-xs text-muted-foreground" htmlFor={`ip-${key}`}>
        {label}
      </label>
      <input
        id={`ip-${key}`}
        type={opts?.type ?? 'text'}
        value={form[key]}
        onChange={set(key)}
        dir={opts?.dir}
        className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
      />
    </div>
  );

  const reading = !!receipt && receipt.extractionStatus === 'pending' && !timedOut;
  const showForm = !!receipt && !reading;
  const readFailed = showForm && (receipt.extractionStatus !== 'done' || !receipt.extracted);

  return (
    <div className="mt-4" data-testid="instapay-receipt">
      {proof?.status === 'rejected' && (
        <div
          className="mb-3 rounded-lg border border-destructive/40 p-3"
          data-testid="instapay-proof-rejected"
        >
          <p className="text-sm font-medium text-destructive-ink">
            {t('The store did not accept this transfer.', 'المتجر مقبلش التحويل ده.')}
          </p>
          {proof.reviewNote && (
            <p className="mt-1 text-sm text-foreground">
              {t('Reason', 'السبب')}: {proof.reviewNote}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {t('You can upload the right receipt below.', 'تقدر ترفع الإيصال الصح تحت.')}
          </p>
        </div>
      )}

      {!receipt && (
        <>
          <label className="text-sm font-medium text-foreground" htmlFor="instapay-receipt-file">
            {t('After you transfer, upload the receipt', 'بعد التحويل، ارفع صورة الإيصال')}
          </label>
          <input
            id="instapay-receipt-file"
            type="file"
            accept={INSTAPAY_RECEIPT_MIME_TYPES.join(',')}
            disabled={uploading}
            onChange={e => void onFile(e.target.files?.[0])}
            className="mt-1 block w-full text-base sm:text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              'JPG, PNG or WebP, up to 8 MB. The store owner reviews it.',
              'JPG أو PNG أو WebP، لحد 8 ميجا. صاحب المتجر هو اللي بيراجعه.'
            )}
          </p>
          {uploading && (
            <p className="mt-1 text-xs text-muted-foreground">{t('Uploading…', 'جاري الرفع…')}</p>
          )}
        </>
      )}

      {reading && (
        <p className="text-sm text-muted-foreground" data-testid="instapay-reading">
          {t('Reading your receipt…', 'بنقرا الإيصال…')}
        </p>
      )}

      {showForm && (
        <div className="space-y-3" data-testid="instapay-receipt-form">
          <p className="text-sm text-muted-foreground">
            {readFailed
              ? t(
                  'We could not read it automatically — please fill in the details.',
                  'معرفناش نقرا الإيصال تلقائي — من فضلك املا البيانات.'
                )
              : t(
                  'Check the details below against your receipt and correct anything that is wrong.',
                  'راجع البيانات دي على الإيصال وصحّح أي حاجة غلط.'
                )}
          </p>
          {field('amount', t('Amount (EGP)', 'المبلغ (ج.م)'), { dir: 'ltr' })}
          {field('reference', t('Transfer reference', 'مرجع التحويل'), { dir: 'ltr' })}
          <div className="grid grid-cols-2 gap-2">
            {field('transferDate', t('Date', 'التاريخ'), { type: 'date', dir: 'ltr' })}
            {field('transferTime', t('Time', 'الوقت'), { type: 'time', dir: 'ltr' })}
          </div>
          {field('payerName', t('Sender name (as shown)', 'اسم المُحوِّل (زي ما هو مكتوب)'))}
          {field('payerAddress', t('Sender InstaPay address', 'عنوان إنستاباي للمُحوِّل'), {
            dir: 'ltr',
          })}
          {field('payerMobile', t('Sender mobile', 'موبايل المُحوِّل'), { dir: 'ltr' })}
          {field('payerBank', t('Sender bank', 'بنك المُحوِّل'))}
          {field('receiverName', t('Receiver name', 'اسم المستلم'))}
          {field('receiverHandle', t('Receiver InstaPay address', 'عنوان إنستاباي للمستلم'), {
            dir: 'ltr',
          })}
          {field('receiverMobile', t('Receiver mobile', 'موبايل المستلم'), { dir: 'ltr' })}
          {field('note', t('Note', 'ملاحظة'))}
          <Button type="button" onClick={() => void submit()} disabled={submitting}>
            {t('Send receipt', 'أرسل الإيصال')}
          </Button>
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-destructive-ink" role="alert" data-testid="instapay-error">
          {error}
        </p>
      )}
    </div>
  );
}
