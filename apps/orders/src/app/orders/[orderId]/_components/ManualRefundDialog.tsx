'use client';

import { useEffect, useId, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';

export const MANUAL_REFUND_METHODS = [
  'cash',
  'instapay',
  'bank_transfer',
  'store_credit',
  'other',
] as const;
export type ManualRefundMethod = (typeof MANUAL_REFUND_METHODS)[number];

export interface ManualRefundInput {
  method: ManualRefundMethod;
  reference: string;
}

interface ManualRefundDialogProps {
  open: boolean;
  /** Resolves to null on success (the dialog closes) or the message to show inside it. */
  onConfirm: (input: ManualRefundInput) => Promise<string | null>;
  onClose: () => void;
}

/**
 * "Refunded" status confirm. Records a refund the merchant has ALREADY paid out: asks how they
 * paid it (and an optional reference), says no money is sent, and shows the API's refusal inline.
 */
export function ManualRefundDialog({ open, onConfirm, onClose }: ManualRefundDialogProps) {
  const { t } = useLanguage();
  const ta = t.detail.actions;
  const methodId = useId();
  const refId = useId();
  const [method, setMethod] = useState<ManualRefundMethod>('cash');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setMethod('cash');
      setReference('');
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const message = await onConfirm({ method, reference });
      if (message) setError(message);
      else onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const field =
    'mt-1 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manual-refund-title"
    >
      <div className="w-full max-w-sm rounded-t-3xl border border-border bg-card p-5 shadow-xl sm:rounded-3xl">
        <p id="manual-refund-title" className="text-sm font-semibold text-foreground">
          {ta.manualRefundTitle}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">{ta.manualRefundDesc}</p>

        <label htmlFor={methodId} className="mt-4 block text-xs font-medium text-foreground">
          {ta.manualRefundMethodLabel}
        </label>
        <select
          id={methodId}
          value={method}
          disabled={submitting}
          onChange={e => setMethod(e.target.value as ManualRefundMethod)}
          className={field}
        >
          {MANUAL_REFUND_METHODS.map(m => (
            <option key={m} value={m}>
              {ta.manualRefundMethods[m]}
            </option>
          ))}
        </select>

        <label htmlFor={refId} className="mt-3 block text-xs font-medium text-foreground">
          {ta.manualRefundReferenceLabel}
        </label>
        <input
          id={refId}
          type="text"
          value={reference}
          maxLength={120}
          disabled={submitting}
          onChange={e => setReference(e.target.value)}
          placeholder={ta.manualRefundReferencePlaceholder}
          className={field}
        />

        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive-ink">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="flex-1 inline-flex h-11 items-center justify-center rounded-xl bg-destructive text-sm font-semibold text-destructive-foreground disabled:opacity-50 active:opacity-80"
          >
            {submitting ? '…' : ta.manualRefundConfirm}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="flex-1 inline-flex h-11 items-center justify-center rounded-xl border border-border bg-card text-sm font-semibold text-foreground disabled:opacity-50 active:bg-muted/60"
          >
            {ta.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
