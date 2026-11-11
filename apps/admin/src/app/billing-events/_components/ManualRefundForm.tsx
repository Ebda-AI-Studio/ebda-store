'use client';

import { useRef, useState } from 'react';
import { Input, Modal, Select } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import {
  INSTAPAY_RECEIPT_MIME_TYPES,
  normalizeInstapayReference,
  toAsciiDigits,
  tryToMinor,
} from '@ebda/shared';
import { apiPost } from '../../../lib/api';
import { postMultipart } from '../../../components/instapay/api';
import { useT } from '../../../i18n/useT';

export interface ManualRefundTarget {
  eventId: string;
  storeName: string;
}

const dayString = (d: Date) => d.toISOString().slice(0, 10);

/**
 * "Record refund / void" on a manual_payment ledger row
 * (POST /admin/billing/events/:id/manual-refund). A refund means the money was
 * sent back outside Ebda; a void means the payment was recorded by mistake and
 * frees its reference. Sent as JSON, or as multipart when a screenshot is attached.
 */
export function ManualRefundForm({
  target,
  onClose,
  onDone,
}: {
  target: ManualRefundTarget;
  onClose: () => void;
  onDone: (outcome: 'recorded' | 'duplicate', voidedEventId?: string) => void;
}) {
  const t = useT('billingEvents.manualRefund');
  const tCommon = useT('common');
  const [kind, setKind] = useState<'refund' | 'void'>('refund');
  const [reference, setReference] = useState('');
  const [refundDate, setRefundDate] = useState(dayString(new Date()));
  const [refundTime, setRefundTime] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [newPeriodEnd, setNewPeriodEnd] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const isRefund = kind === 'refund';
    const normalizedRef = normalizeInstapayReference(reference);
    if (isRefund && !normalizedRef) found.reference = t('referenceInvalid');
    if (!refundDate) found.refundDate = t('dateRequired');
    if (isRefund && !recipientName.trim()) found.recipientName = t('recipientRequired');
    let amountMinor: number | null = null;
    if (isRefund && amount.trim()) {
      amountMinor = tryToMinor(amount.trim());
      if (amountMinor === null || amountMinor <= 0) found.amount = t('amountInvalid');
    }
    if (note.trim().length < 3) found.note = t('noteRequired');
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const time = toAsciiDigits(refundTime.trim());
    const fields = {
      kind,
      refundDate,
      note: note.trim(),
      ...(isRefund && normalizedRef ? { reference: normalizedRef } : {}),
      ...(isRefund ? { recipientName: recipientName.trim() } : {}),
      ...(isRefund && amountMinor !== null ? { amountMinor } : {}),
      ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? { refundTime: time } : {}),
      ...(newPeriodEnd
        ? { newPeriodEnd: new Date(`${newPeriodEnd}T00:00:00.000Z`).toISOString() }
        : {}),
    };
    const endpoint = `/api/v1/admin/billing/events/${target.eventId}/manual-refund`;

    setFormError('');
    setSaving(true);
    let result: { duplicate: boolean; voidedEventId?: string } | null = null;
    if (file) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
      form.append('file', file);
      result = (await postMultipart<{ duplicate: boolean; voidedEventId?: string }>(endpoint, form))
        .data;
    } else {
      result = (await apiPost<{ duplicate: boolean; voidedEventId?: string }>(endpoint, fields))
        .data;
    }
    setSaving(false);
    if (!result) {
      setFormError(t('failed'));
      return;
    }
    onDone(result.duplicate ? 'duplicate' : 'recorded', result.voidedEventId);
  }

  const isRefund = kind === 'refund';
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('title', { store: target.storeName })}
      className="max-h-[90vh] overflow-y-auto"
    >
      <form onSubmit={submit} noValidate className="space-y-3 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
        {formError && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
          >
            {formError}
          </div>
        )}
        <Select
          label={t('kind')}
          value={kind}
          onChange={e => setKind(e.target.value as 'refund' | 'void')}
          options={[
            { value: 'refund', label: t('kinds.refund') },
            { value: 'void', label: t('kinds.void') },
          ]}
        />
        {isRefund && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                id="mr-reference"
                dir="ltr"
                inputMode="numeric"
                label={t('reference')}
                value={reference}
                onChange={e => setReference(e.target.value)}
                error={errors.reference}
              />
              <Input
                id="mr-amount"
                dir="ltr"
                inputMode="decimal"
                label={t('amount')}
                value={amount}
                onChange={e => setAmount(e.target.value)}
                error={errors.amount}
              />
            </div>
            <Input
              id="mr-recipient"
              label={t('recipientName')}
              value={recipientName}
              onChange={e => setRecipientName(e.target.value)}
              error={errors.recipientName}
            />
          </>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            id="mr-date"
            type="date"
            dir="ltr"
            label={t('refundDate')}
            value={refundDate}
            onChange={e => setRefundDate(e.target.value)}
            error={errors.refundDate}
          />
          <Input
            id="mr-time"
            type="time"
            dir="ltr"
            label={t('refundTime')}
            value={refundTime}
            onChange={e => setRefundTime(e.target.value)}
          />
        </div>
        <Input
          id="mr-note"
          label={t('note')}
          value={note}
          onChange={e => setNote(e.target.value)}
          error={errors.note}
        />
        <Input
          id="mr-period-end"
          type="date"
          dir="ltr"
          label={t('newPeriodEnd')}
          value={newPeriodEnd}
          onChange={e => setNewPeriodEnd(e.target.value)}
        />
        {isRefund && (
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
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t('saving') : t('submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
