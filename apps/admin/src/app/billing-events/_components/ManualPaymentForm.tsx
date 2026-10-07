'use client';

import { useState } from 'react';
import { Button, Input, Modal, Select } from '@force/ui';
import { minorToDecimalString, tryToMinor } from '@force/shared';
import { apiPost } from '../../../lib/api';
import { useT } from '../../../i18n/useT';

export interface ManualPaymentPrefill {
  storeId: string;
  storeName: string;
  planCode: string;
  interval: 'monthly' | 'yearly';
  amountMinor: number | null;
  method: 'instapay' | 'bank' | 'cash';
  reference: string;
  claimId?: string;
}

const PLAN_CODES = ['basic', 'growth', 'business'] as const;
const METHODS = ['instapay', 'bank', 'cash'] as const;

const dayString = (d: Date) => d.toISOString().slice(0, 10);

/** `date` + one month/year, clamped to the month's last day (Jan 31 + 1 month = Feb 28/29). */
export function addPeriod(date: string, interval: 'monthly' | 'yearly'): string {
  const [y, m, d] = date.split('-').map(Number);
  const months = interval === 'yearly' ? 12 : 1;
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return dayString(target);
}

const toIso = (day: string) => new Date(`${day}T00:00:00.000Z`).toISOString();

/**
 * "Record manual payment & activate" (POST /admin/stores/:id/manual-payment).
 * The amount is typed in EGP and converted to piastres with a string parser,
 * never float math. The API is idempotent on `reference`, so a repeat submit
 * answers `duplicate: true` and changes nothing.
 */
export function ManualPaymentForm({
  prefill,
  onClose,
  onDone,
}: {
  prefill: ManualPaymentPrefill;
  onClose: () => void;
  onDone: (outcome: 'recorded' | 'duplicate') => void;
}) {
  const t = useT('billingEvents.manual');
  const tPlans = useT('billingEvents.plans');
  const tCommon = useT('common');
  const today = dayString(new Date());
  const initialPlan = (PLAN_CODES as readonly string[]).includes(prefill.planCode)
    ? prefill.planCode
    : 'basic';
  const [planCode, setPlanCode] = useState(initialPlan);
  const [interval, setInterval] = useState(prefill.interval);
  const [amount, setAmount] = useState(
    prefill.amountMinor !== null ? minorToDecimalString(prefill.amountMinor) : ''
  );
  const [method, setMethod] = useState(prefill.method);
  const [reference, setReference] = useState(prefill.reference);
  const [paidAt, setPaidAt] = useState(today);
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(addPeriod(today, prefill.interval));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const amountMinor = tryToMinor(amount.trim());
    if (amountMinor === null || amountMinor <= 0) found.amount = t('amountInvalid');
    if (!reference.trim()) found.reference = t('referenceRequired');
    if (!paidAt) found.paidAt = t('dateRequired');
    if (!periodStart) found.periodStart = t('dateRequired');
    if (!periodEnd) found.periodEnd = t('dateRequired');
    else if (periodStart && periodEnd <= periodStart) found.periodEnd = t('periodInvalid');
    setErrors(found);
    if (Object.keys(found).length > 0 || amountMinor === null) return;

    setFormError('');
    setSaving(true);
    const { data, error } = await apiPost<{ duplicate: boolean }>(
      `/api/v1/admin/stores/${prefill.storeId}/manual-payment`,
      {
        planCode,
        interval,
        amountMinor,
        method,
        reference: reference.trim(),
        paidAt: toIso(paidAt),
        periodStart: toIso(periodStart),
        periodEnd: toIso(periodEnd),
        ...(prefill.claimId ? { claimId: prefill.claimId } : {}),
      }
    );
    setSaving(false);
    if (error || !data) {
      setFormError(t('failed'));
      return;
    }
    onDone(data.duplicate ? 'duplicate' : 'recorded');
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('title', { store: prefill.storeName })}
      className="max-h-[90vh] overflow-y-auto"
    >
      <form onSubmit={submit} noValidate className="space-y-3 p-4 sm:p-6">
        {formError && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
          >
            {formError}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t('plan')}
            value={planCode}
            onChange={e => setPlanCode(e.target.value)}
            options={PLAN_CODES.map(c => ({ value: c, label: tPlans(c) }))}
          />
          <Select
            label={t('interval')}
            value={interval}
            onChange={e => {
              const next = e.target.value as 'monthly' | 'yearly';
              setInterval(next);
              setPeriodEnd(addPeriod(periodStart || today, next));
            }}
            options={[
              { value: 'monthly', label: t('monthly') },
              { value: 'yearly', label: t('yearly') },
            ]}
          />
        </div>
        <Input
          id="mp-amount"
          dir="ltr"
          inputMode="decimal"
          label={t('amount')}
          value={amount}
          onChange={e => setAmount(e.target.value)}
          error={errors.amount}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t('method')}
            value={method}
            onChange={e => setMethod(e.target.value as (typeof METHODS)[number])}
            options={METHODS.map(m => ({ value: m, label: t(`methods.${m}`) }))}
          />
          <Input
            id="mp-reference"
            dir="ltr"
            label={t('reference')}
            value={reference}
            onChange={e => setReference(e.target.value)}
            error={errors.reference}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            id="mp-paid-at"
            type="date"
            dir="ltr"
            label={t('paidAt')}
            value={paidAt}
            onChange={e => setPaidAt(e.target.value)}
            error={errors.paidAt}
          />
          <Input
            id="mp-period-start"
            type="date"
            dir="ltr"
            label={t('periodStart')}
            value={periodStart}
            onChange={e => {
              setPeriodStart(e.target.value);
              if (e.target.value) setPeriodEnd(addPeriod(e.target.value, interval));
            }}
            error={errors.periodStart}
          />
          <Input
            id="mp-period-end"
            type="date"
            dir="ltr"
            label={t('periodEnd')}
            value={periodEnd}
            onChange={e => setPeriodEnd(e.target.value)}
            error={errors.periodEnd}
          />
        </div>
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
