'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { formatMoney } from '@ebda/shared';
import { DataTable, type DataTableColumn } from '../../../components/mobile/DataTable';
import { apiGet } from '../../../lib/api';
import { useT } from '../../../i18n/useT';
import { fmtDate } from '../../../components/billing/format';

interface GrantRow {
  id: string;
  kind: 'founding' | 'referral_referrer' | 'referral_referred';
  status: 'pending' | 'applied';
  months: number;
  valueMinor: number;
  beneficiaryName: string | null;
  counterpartName: string | null;
  periodEndAfter: string | null;
  createdAt: string;
}
interface GrantsData {
  foundingUsed: number;
  foundingSlots: number;
  referralGrants: number;
  referrerMax: number;
  totalValueMinor: number;
  grants: GrantRow[];
}

/** Super-admin "Free months": every founding-20 and referral grant, with the caps used. */
export function GrantsPanel({ refreshKey }: { refreshKey: number }) {
  const t = useT('billingEvents.grants');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [data, setData] = useState<GrantsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiGet<GrantsData>('/api/v1/admin/billing/grants?limit=200').then(({ data: d, error }) => {
      if (!live) return;
      setFailed(!!error);
      setData(d ?? null);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const columns: DataTableColumn<GrantRow>[] = [
    {
      header: t('columns.date'),
      cell: r => <span className="text-muted-foreground">{fmtDate(r.createdAt, locale)}</span>,
    },
    {
      header: t('columns.store'),
      primaryOnMobile: true,
      cell: r => <span className="font-medium text-foreground">{r.beneficiaryName ?? '—'}</span>,
    },
    { header: t('columns.kind'), cell: r => <span>{t(`kinds.${r.kind}`)}</span> },
    { header: t('columns.counterpart'), cell: r => <span>{r.counterpartName ?? '—'}</span> },
    { header: t('columns.months'), cell: r => <span className="tabular-nums">{r.months}</span> },
    {
      header: t('columns.value'),
      cell: r => (
        <span className="tabular-nums">
          {formatMoney(r.valueMinor, locale, { fixedDecimals: true })}
        </span>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: r => (
        <Badge variant={r.status === 'applied' ? 'success' : 'warning'}>
          {t(`statuses.${r.status}`)}
        </Badge>
      ),
    },
    {
      header: t('columns.paidThrough'),
      cell: r => <span>{r.periodEndAfter ? fmtDate(r.periodEndAfter, locale) : '—'}</span>,
    },
  ];

  if (loading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  if (failed || !data)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('failedToLoad')}
      </p>
    );
  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-3 text-sm">
        <li className="rounded-md bg-muted px-3 py-2">
          {t('foundingUsed', { used: data.foundingUsed, slots: data.foundingSlots })}
        </li>
        <li className="rounded-md bg-muted px-3 py-2">
          {t('referralGrants', { count: data.referralGrants, max: data.referrerMax })}
        </li>
        <li className="rounded-md bg-muted px-3 py-2">
          {t('totalValue', {
            amount: formatMoney(data.totalValueMinor, locale, { fixedDecimals: true }),
          })}
        </li>
      </ul>
      <DataTable
        ariaLabel={t('title')}
        columns={columns}
        rows={data.grants}
        rowKey={r => r.id}
        emptyState={<p className="text-sm text-muted-foreground">{t('empty')}</p>}
      />
    </div>
  );
}
