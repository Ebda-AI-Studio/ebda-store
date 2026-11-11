'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Input, Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@ebda/shared';
import { DataTable, type DataTableColumn } from '../../../components/mobile/DataTable';
import { apiGet, apiPost } from '../../../lib/api';
import { useT } from '../../../i18n/useT';
import { fmtDate } from '../../../components/billing/format';

export interface HeldRow {
  id: string;
  provider: string;
  eventId: string;
  receivedAt: string;
  status: 'open' | 'resolved';
  reason?: string;
  storeId?: string | null;
  merchantOrderId?: string | null;
  providerRef?: string | null;
  expectedMinor?: number | null;
  gotMinor?: number | null;
  expectedCurrency?: string | null;
  gotCurrency?: string | null;
  resolution?: { action: string; note: string; by: string; at: string };
}

const STATUSES = ['open', 'resolved'] as const;
const ACTIONS = ['credited', 'refunded', 'not_ours'] as const;
const REASONS = [
  'unknown_order',
  'amount_mismatch',
  'currency_mismatch',
  'amount_missing',
  'currency_missing',
  'kind_mismatch',
] as const;

/**
 * Super-admin "Held payments" (#627): subscription charges a provider reported as SUCCESSFUL that did not match what we
 * billed. The merchant may have paid without being upgraded, so each one stays here until a person credits the plan,
 * refunds it at the provider, or confirms it is not ours.
 */
export function HeldPaymentsPanel({
  refreshKey,
  onChanged,
}: {
  refreshKey: number;
  onChanged: (message: string) => void;
}) {
  const t = useT('billingEvents.held');
  const tCommon = useT('common');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('open');
  const [rows, setRows] = useState<HeldRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [resolving, setResolving] = useState<HeldRow | null>(null);
  const [action, setAction] = useState<(typeof ACTIONS)[number]>('credited');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const { data, error } = await apiGet<{ held: HeldRow[] }>(
      `/api/v1/admin/billing/held-webhooks?status=${status}&limit=200`
    );
    setLoadError(!!error);
    setRows(data?.held ?? []);
    setLoading(false);
  }, [status]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows, refreshKey]);

  const money = (minor: number | null | undefined, currency: string | null | undefined) =>
    typeof minor === 'number'
      ? `${formatMoney(minor, locale, { fixedDecimals: true })}${currency && currency !== 'EGP' ? ` ${currency}` : ''}`
      : t('unknownAmount');

  async function resolve() {
    if (!resolving) return;
    if (note.trim().length < 3) {
      setNoteError(t('noteRequired'));
      return;
    }
    setBusy(true);
    const { error } = await apiPost(`/api/v1/admin/billing/held-webhooks/${resolving.id}/resolve`, {
      action,
      note: note.trim(),
    });
    setBusy(false);
    if (error) {
      setNoteError(t('resolveFailed'));
      return;
    }
    setResolving(null);
    setNote('');
    setNoteError('');
    onChanged(t('resolved'));
    void fetchRows();
  }

  const reasonLabel = (r: string | undefined) =>
    r && (REASONS as readonly string[]).includes(r) ? t(`reasons.${r}`) : (r ?? '—');

  const columns: DataTableColumn<HeldRow>[] = [
    {
      header: t('columns.date'),
      cell: r => <span className="text-muted-foreground">{fmtDate(r.receivedAt, locale)}</span>,
    },
    {
      header: t('columns.reason'),
      primaryOnMobile: true,
      cell: r => <span className="font-medium text-foreground">{reasonLabel(r.reason)}</span>,
    },
    {
      header: t('columns.expected'),
      cell: r => <span className="tabular-nums">{money(r.expectedMinor, r.expectedCurrency)}</span>,
    },
    {
      header: t('columns.got'),
      cell: r => <span className="tabular-nums">{money(r.gotMinor, r.gotCurrency)}</span>,
    },
    {
      header: t('columns.reference'),
      cell: r => (
        <span className="font-mono text-xs" dir="ltr">
          {r.provider} · {r.providerRef ?? r.eventId}
        </span>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: r => (
        <Badge variant={r.status === 'open' ? 'warning' : 'success'}>
          {r.status === 'open'
            ? t('statuses.open')
            : t(`actions.${r.resolution?.action ?? 'credited'}`)}
        </Badge>
      ),
    },
    {
      header: t('columns.action'),
      mobileActions: true,
      cell: r =>
        r.status === 'open' ? (
          <Button
            size="sm"
            className="max-md:min-h-11 max-md:px-4"
            onClick={() => {
              setResolving(r);
              setAction('credited');
              setNote('');
              setNoteError('');
            }}
          >
            {t('resolve')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{r.resolution?.note ?? ''}</span>
        ),
    },
  ];

  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">{t('intro')}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('statusFilter')}</span>
        {STATUSES.map(s => (
          <Button
            variant={status === s ? 'soft' : 'ghost'}
            size="sm"
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
          >
            {t(`statuses.${s}`)}
          </Button>
        ))}
      </div>
      {loading ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
          {t('loading')}
        </div>
      ) : (
        <DataTable<HeldRow>
          ariaLabel={t('title')}
          columns={columns}
          rows={rows}
          rowKey={r => r.id}
          emptyState={
            loadError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-6 text-center text-destructive-ink"
              >
                {t('failedToLoad')}
              </div>
            ) : (
              <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
                {t('empty')}
              </div>
            )
          }
        />
      )}
      {resolving && (
        <Modal isOpen onClose={() => setResolving(null)} title={t('resolveTitle')}>
          <form
            className="space-y-3 p-4 sm:p-6"
            noValidate
            onSubmit={e => {
              e.preventDefault();
              void resolve();
            }}
          >
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">{t('actionLabel')}</legend>
              {ACTIONS.map(a => (
                <label key={a} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="held-action"
                    value={a}
                    checked={action === a}
                    onChange={() => setAction(a)}
                  />
                  {t(`actions.${a}`)}
                </label>
              ))}
            </fieldset>
            <Input
              id="held-note"
              label={t('note')}
              value={note}
              onChange={e => setNote(e.target.value)}
              error={noteError || undefined}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setResolving(null)}>
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {t('resolveSubmit')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
