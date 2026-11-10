'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import {
  INSTAPAY_RECEIPT_MAX_BYTES,
  INSTAPAY_RECEIPT_MIME_TYPES,
  minorToDecimalString,
  normalizeInstapayReference,
  toAsciiDigits,
  tryToMinor,
  type InstapayReceiptView,
} from '@ebda/shared';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { postMultipart, receiptErrorKey } from './api';

const POLL_MS = 2000;
const POLL_MAX = 15; // ~30 s, then the payer fills the form by hand

type Phase = 'idle' | 'uploading' | 'reading' | 'editing' | 'submitting';

interface Values {
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

const EMPTY: Values = {
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

/** The AI's reading becomes the form's starting values; the payer may correct any of them. */
function prefill(receipt: InstapayReceiptView): Values {
  const x = receipt.extracted;
  if (!x) return EMPTY;
  return {
    amount: x.amountMinor !== null ? minorToDecimalString(x.amountMinor) : '',
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

const orNull = (v: string) => (v.trim() ? v.trim() : null);

/**
 * Upload a transfer screenshot, let the AI read it, correct the fields, submit.
 * `baseUrl` is the receipts collection of whoever pays (the merchant's
 * `/billing/receipts`): POST uploads, GET `:id` polls, POST `:id/submit` sends.
 * Who reviews is the caller's sentence (`reviewerNote`), never assumed here.
 */
export function InstapayReceiptForm({
  baseUrl,
  reviewerNote,
  onSubmitted,
}: {
  baseUrl: string;
  /** "The Ebda team will review your transfer." (already translated). */
  reviewerNote: string;
  onSubmitted: () => void;
}) {
  const t = useT('instapayReceipt.form');
  const tErr = useT('instapayReceipt.errors');
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [receipt, setReceipt] = useState<InstapayReceiptView | null>(null);
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pollRef = useRef<{ cancelled: boolean } | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) pollRef.current.cancelled = true;
    },
    []
  );

  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues(v => ({ ...v, [key]: e.target.value }));

  function startEditing(r: InstapayReceiptView, failed: boolean) {
    setReceipt(r);
    setValues(failed ? EMPTY : prefill(r));
    setReadFailed(failed);
    setPhase('editing');
  }

  async function poll(first: InstapayReceiptView) {
    const token = { cancelled: false };
    pollRef.current = token;
    let current = first;
    for (let i = 0; i < POLL_MAX && !token.cancelled; i++) {
      if (current.extractionStatus !== 'pending') break;
      await new Promise(res => setTimeout(res, POLL_MS));
      if (token.cancelled) return;
      const { data } = await apiGet<{ receipt: InstapayReceiptView }>(`${baseUrl}/${current.id}`);
      if (data?.receipt) current = data.receipt;
    }
    if (token.cancelled) return;
    // Still pending after ~30 s counts as unread: manual entry, nothing is lost.
    startEditing(current, current.extractionStatus !== 'done');
  }

  async function upload() {
    setMessage(null);
    if (!file) {
      setMessage({ tone: 'error', text: t('noFile') });
      return;
    }
    if (!(INSTAPAY_RECEIPT_MIME_TYPES as readonly string[]).includes(file.type)) {
      setMessage({ tone: 'error', text: tErr('INVALID_FILE_TYPE') });
      return;
    }
    if (file.size > INSTAPAY_RECEIPT_MAX_BYTES) {
      setMessage({ tone: 'error', text: tErr('FILE_TOO_LARGE') });
      return;
    }
    setPhase('uploading');
    const form = new FormData();
    form.append('file', file);
    const { data, error } = await postMultipart<{ receipt: InstapayReceiptView }>(baseUrl, form);
    if (error || !data?.receipt) {
      setPhase('idle');
      setMessage({ tone: 'error', text: tErr(receiptErrorKey(error?.code)) });
      return;
    }
    setPhase('reading');
    await poll(data.receipt);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!receipt) return;
    const found: Partial<Record<keyof Values, string>> = {};
    const amountMinor = tryToMinor(values.amount.trim());
    if (amountMinor === null || amountMinor <= 0) found.amount = t('amountInvalid');
    const reference = normalizeInstapayReference(values.reference);
    if (!reference) found.reference = t('referenceInvalid');
    const date = toAsciiDigits(values.transferDate.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) found.transferDate = t('dateInvalid');
    const time = toAsciiDigits(values.transferTime.trim());
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) found.transferTime = t('timeInvalid');
    if (!values.payerName.trim()) found.payerName = t('payerNameRequired');
    setErrors(found);
    if (Object.keys(found).length > 0 || amountMinor === null || !reference) return;

    setMessage(null);
    setPhase('submitting');
    const { error } = await apiPost(`${baseUrl}/${receipt.id}/submit`, {
      amountMinor,
      reference,
      transferDate: date,
      transferTime: time,
      payerName: values.payerName.trim(),
      payerAddress: orNull(values.payerAddress),
      payerMobile: orNull(values.payerMobile),
      payerBank: orNull(values.payerBank),
      receiverName: orNull(values.receiverName),
      receiverHandle: orNull(values.receiverHandle),
      receiverMobile: orNull(values.receiverMobile),
      note: orNull(values.note),
    });
    if (error) {
      setPhase('editing');
      setMessage({ tone: 'error', text: tErr(receiptErrorKey(error.code)) });
      return;
    }
    reset();
    onSubmitted();
  }

  function reset() {
    setPhase('idle');
    setFile(null);
    setReceipt(null);
    setValues(EMPTY);
    setErrors({});
    setMessage(null);
    if (input.current) input.current.value = '';
  }

  const busy = phase === 'uploading' || phase === 'reading' || phase === 'submitting';

  return (
    <div id="instapay-upload" className="space-y-3">
      <h4 className="text-sm font-medium">{t('title')}</h4>
      <p className="text-xs text-muted-foreground">{t('help')}</p>
      <p className="text-xs font-medium text-foreground" data-testid="receipt-reviewer-note">
        {reviewerNote}
      </p>

      {(phase === 'idle' || phase === 'uploading' || phase === 'reading') && (
        <div className="space-y-2">
          <input
            ref={input}
            type="file"
            accept={INSTAPAY_RECEIPT_MIME_TYPES.join(',')}
            aria-label={t('file')}
            disabled={busy}
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:me-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
          />
          <p className="text-xs text-muted-foreground">{t('fileHint')}</p>
          <Button className="max-md:min-h-11" disabled={busy || !file} onClick={upload}>
            {phase === 'uploading'
              ? t('uploading')
              : phase === 'reading'
                ? t('reading')
                : t('upload')}
          </Button>
        </div>
      )}

      {(phase === 'editing' || phase === 'submitting') && receipt && (
        <form onSubmit={submit} noValidate className="space-y-3">
          <p role="status" className="text-xs text-muted-foreground">
            {readFailed ? t('readFailed') : t('readOk')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              id="ipr-amount"
              dir="ltr"
              inputMode="decimal"
              label={t('amount')}
              value={values.amount}
              onChange={set('amount')}
              error={errors.amount}
            />
            <Input
              id="ipr-reference"
              dir="ltr"
              inputMode="numeric"
              label={t('reference')}
              value={values.reference}
              onChange={set('reference')}
              error={errors.reference}
            />
            <Input
              id="ipr-date"
              dir="ltr"
              type="date"
              label={t('transferDate')}
              value={values.transferDate}
              onChange={set('transferDate')}
              error={errors.transferDate}
            />
            <Input
              id="ipr-time"
              dir="ltr"
              type="time"
              label={t('transferTime')}
              value={values.transferTime}
              onChange={set('transferTime')}
              error={errors.transferTime}
            />
          </div>
          <Input
            id="ipr-payer-name"
            label={t('payerName')}
            value={values.payerName}
            onChange={set('payerName')}
            error={errors.payerName}
          />
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">{t('moreDetails')}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Input
                id="ipr-payer-address"
                dir="ltr"
                label={t('payerAddress')}
                value={values.payerAddress}
                onChange={set('payerAddress')}
              />
              <Input
                id="ipr-payer-mobile"
                dir="ltr"
                label={t('payerMobile')}
                value={values.payerMobile}
                onChange={set('payerMobile')}
              />
              <Input
                id="ipr-payer-bank"
                label={t('payerBank')}
                value={values.payerBank}
                onChange={set('payerBank')}
              />
              <Input
                id="ipr-receiver-name"
                label={t('receiverName')}
                value={values.receiverName}
                onChange={set('receiverName')}
              />
              <Input
                id="ipr-receiver-handle"
                dir="ltr"
                label={t('receiverHandle')}
                value={values.receiverHandle}
                onChange={set('receiverHandle')}
              />
              <Input
                id="ipr-receiver-mobile"
                dir="ltr"
                label={t('receiverMobile')}
                value={values.receiverMobile}
                onChange={set('receiverMobile')}
              />
              <div className="sm:col-span-2">
                <Input id="ipr-note" label={t('note')} value={values.note} onChange={set('note')} />
              </div>
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="max-md:min-h-11" disabled={phase === 'submitting'}>
              {phase === 'submitting' ? t('sending') : t('send')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="max-md:min-h-11"
              disabled={phase === 'submitting'}
              onClick={reset}
            >
              {t('changeFile')}
            </Button>
          </div>
        </form>
      )}

      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.tone === 'error' ? 'text-destructive-ink' : 'text-muted-foreground'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
