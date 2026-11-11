'use client';

import { useRef, useState } from 'react';
import { Input, Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import {
  INSTAPAY_RECEIPT_MIME_TYPES,
  minorToDecimalString,
  normalizeInstapayReference,
  toAsciiDigits,
  tryToMinor,
} from '@ebda/shared';
import { apiPost } from '../../../../../../lib/api';
import { postMultipart } from '../../../../../../components/instapay/api';
import { useT } from '@/i18n/useT';

interface InstapayRefundButtonProps {
  storeId: string;
  orderId: string;
  orderNumber: string;
  /** Piastres still refundable on the InstaPay payment (prefills the amount). */
  remainingMinor: number;
  /** Re-fetch the order after a refund was recorded. */
  onRecorded?: () => void;
  disabled?: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Record an InstaPay refund the owner already sent outside Ebda
 * (POST .../orders/:id/instapay-refund). Ebda moves no money here: it stores the
 * refund reference, date, recipient and amount; a full amount marks the order
 * refunded (stock back, shopper notified). Owner only: staff lack orders:refund.
 */
export function InstapayRefundButton({
  storeId,
  orderId,
  orderNumber,
  remainingMinor,
  onRecorded,
  disabled = false,
}: InstapayRefundButtonProps) {
  const t = useT('instapayReceipt.order.refund');
  const tCommon = useT('common');
  const { success: toastSuccess, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reference, setReference] = useState('');
  const [refundDate, setRefundDate] = useState(today());
  const [refundTime, setRefundTime] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [amount, setAmount] = useState(minorToDecimalString(remainingMinor));
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const ref = normalizeInstapayReference(reference);
    if (!ref) found.reference = t('referenceInvalid');
    if (!refundDate) found.refundDate = t('dateInvalid');
    const time = toAsciiDigits(refundTime.trim());
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) found.refundTime = t('timeInvalid');
    if (!recipientName.trim()) found.recipientName = t('recipientRequired');
    const amountMinor = tryToMinor(amount.trim());
    if (amountMinor === null || amountMinor <= 0) found.amount = t('amountInvalid');
    setErrors(found);
    if (Object.keys(found).length > 0 || !ref || amountMinor === null) return;

    const fields = {
      reference: ref,
      refundDate,
      recipientName: recipientName.trim(),
      amountMinor,
      ...(time ? { refundTime: time } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const endpoint = `/api/v1/stores/${storeId}/orders/${orderId}/instapay-refund`;
    setSaving(true);
    let res: { data: { duplicate: boolean } | null; error: { code: string } | null };
    if (file) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
      form.append('file', file);
      res = await postMultipart<{ duplicate: boolean }>(endpoint, form);
    } else {
      res = await apiPost<{ duplicate: boolean }>(endpoint, fields);
    }
    setSaving(false);
    const result = res.data;
    if (!result) {
      // the one refundable balance (#659): earlier refunds already cover this, say so instead of a generic failure
      toastError(res.error?.code === 'REFUND_EXCEEDS_ORDER' ? t('exceedsOrder') : t('failed'));
      return;
    }
    toastSuccess(result.duplicate ? t('duplicate') : t('done'));
    setOpen(false);
    onRecorded?.();
  }

  return (
    <>
      <Button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        data-testid="instapay-refund-button"
        variant="outline"
        className="flex-1 min-w-[8rem] justify-center gap-2 font-semibold text-destructive-ink"
      >
        {t('button')}
      </Button>
      <Modal
        isOpen={open}
        onClose={() => !saving && setOpen(false)}
        title={`${t('title')} · ${orderNumber}`}
        size="sm"
      >
        <form onSubmit={submit} noValidate className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
          <Input
            id="ir-reference"
            dir="ltr"
            inputMode="numeric"
            label={t('reference')}
            value={reference}
            onChange={e => setReference(e.target.value)}
            error={errors.reference}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              id="ir-date"
              type="date"
              dir="ltr"
              label={t('refundDate')}
              value={refundDate}
              onChange={e => setRefundDate(e.target.value)}
              error={errors.refundDate}
            />
            <Input
              id="ir-time"
              type="time"
              dir="ltr"
              label={t('refundTime')}
              value={refundTime}
              onChange={e => setRefundTime(e.target.value)}
              error={errors.refundTime}
            />
          </div>
          <Input
            id="ir-recipient"
            label={t('recipientName')}
            value={recipientName}
            onChange={e => setRecipientName(e.target.value)}
            error={errors.recipientName}
          />
          <Input
            id="ir-amount"
            dir="ltr"
            inputMode="decimal"
            label={t('amount')}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            error={errors.amount}
          />
          <Input
            id="ir-note"
            label={t('note')}
            value={note}
            onChange={e => setNote(e.target.value)}
          />
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('file')}</span>
            <input
              ref={fileInput}
              type="file"
              accept={INSTAPAY_RECEIPT_MIME_TYPES.join(',')}
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
            />
          </label>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={saving} isLoading={saving}>
              {saving ? t('saving') : t('submit')}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
