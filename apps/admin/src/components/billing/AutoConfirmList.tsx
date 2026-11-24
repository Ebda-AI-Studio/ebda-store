'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Input, Modal } from '@ebda/ui';
import { formatMoney } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataTableColumn } from '../mobile/DataTable';
import { apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { fmtDate } from './format';

export interface AutoConfirmRow {
  id: string;
  storeId: string;
  state: 'pending_decision' | 'auto_confirmed' | 'needs_human' | 'reverted' | 'failed';
  reasons: string[];
  amountMinor: number | null;
  expectedAmountMinor: number;
  createdAt: string;
}

/**
 * The AI verdict of every receipt the auto-confirm path looked at: its state and EVERY reason code (labelled in Arabic and English), and a
 * "not received" button on the automatically confirmed ones (a reason is required; the store then has 48 hours to pay properly).
 */
export function AutoConfirmList({
  rows,
  onChanged,
}: {
  rows: AutoConfirmRow[];
  onChanged: (message: string) => void;
}) {
  const t = useT('billingEvents.autoConfirm');
  const tCommon = useT('common');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [target, setTarget] = useState<AutoConfirmRow | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function revert() {
    if (!target) return;
    if (reason.trim().length < 3) {
      setError(t('revertReason'));
      return;
    }
    setBusy(true);
    const { error: err } = await apiPost(
      `/api/v1/admin/billing/auto-confirmations/${target.id}/revert`,
      { reason: reason.trim() }
    );
    setBusy(false);
    if (err) {
      setError(t('revertFailed'));
      return;
    }
    setTarget(null);
    setReason('');
    setError('');
    onChanged(t('reverted'));
  }

  const columns: DataTableColumn<AutoConfirmRow>[] = [
    {
      header: t('columns.date'),
      cell: r => <span className="text-muted-foreground">{fmtDate(r.createdAt, locale)}</span>,
    },
    {
      header: t('columns.store'),
      primaryOnMobile: true,
      cell: r => (
        <span dir="ltr" className="break-all text-xs">
          {r.storeId}
        </span>
      ),
    },
    {
      header: t('columns.amount'),
      cell: r => (
        <span className="tabular-nums">
          {formatMoney(r.amountMinor ?? r.expectedAmountMinor, locale, { fixedDecimals: true })}
        </span>
      ),
    },
    {
      header: t('columns.state'),
      mobileBadge: true,
      cell: r => (
        <Badge
          variant={
            r.state === 'auto_confirmed'
              ? 'success'
              : r.state === 'reverted' || r.state === 'failed'
                ? 'destructive'
                : 'warning'
          }
        >
          {t(`states.${r.state}`)}
        </Badge>
      ),
    },
    {
      header: t('columns.reasons'),
      cell: r =>
        r.reasons.length === 0 ? (
          <span className="text-muted-foreground">{t('noReasons')}</span>
        ) : (
          <ul className="space-y-0.5 text-sm">
            {r.reasons.map(code => (
              <li key={code}>{t(`reasons.${code}`)}</li>
            ))}
          </ul>
        ),
    },
    {
      header: t('columns.action'),
      mobileActions: true,
      cell: r =>
        r.state === 'auto_confirmed' ? (
          <Button
            size="sm"
            variant="outline"
            className="max-md:min-h-11 max-md:px-4"
            onClick={() => {
              setTarget(r);
              setReason('');
              setError('');
            }}
          >
            {t('notReceived')}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <DataTable<AutoConfirmRow>
        ariaLabel={t('title')}
        columns={columns}
        rows={rows}
        rowKey={r => r.id}
        emptyState={
          <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
            {t('empty')}
          </div>
        }
      />
      {target && (
        <Modal isOpen onClose={() => setTarget(null)} title={t('revertTitle')}>
          <form
            className="space-y-3 p-4 sm:p-6"
            noValidate
            onSubmit={e => {
              e.preventDefault();
              void revert();
            }}
          >
            <Input
              id="auto-revert-reason"
              label={t('revertReason')}
              value={reason}
              onChange={e => setReason(e.target.value)}
              error={error || undefined}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setTarget(null)}>
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={busy || reason.trim().length < 3}>
                {t('revertSubmit')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
