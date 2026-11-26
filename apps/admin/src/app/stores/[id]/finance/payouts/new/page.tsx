'use client';

import { FIELD_CLASSES } from '@/components/ui/tokens';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { FormFooter } from '@/components/FormFooter';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { roundToMinor } from '@ebda/shared';

interface AccountRow {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
}
interface AccountsTree {
  assets: AccountRow[];
}

/** Cash-in-transit accounts a payout can settle: online (1000), card (1010), cash on delivery (1020). */
const SOURCE_CODES = ['1000', '1010', '1020'];

export default function NewPayoutPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('finance.payout');

  const [assets, setAssets] = useState<AccountRow[]>([]);
  const [fromId, setFromId] = useState('');
  const [bankId, setBankId] = useState('');
  const [gross, setGross] = useState('');
  const [fee, setFee] = useState('');
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<AccountsTree>(`/api/v1/stores/${storeId}/finance/accounts`).then(({ data }) => {
      if (data?.assets) setAssets([...data.assets].sort((a, b) => a.code.localeCompare(b.code)));
    });
  }, [storeId]);

  const sources = assets.filter(a => SOURCE_CODES.includes(a.code));
  const label = (a: AccountRow) => `${a.code} — ${a.nameAr ?? a.nameEn}`;
  const grossMinor = roundToMinor(parseFloat(gross) || 0);
  const feeMinor = roundToMinor(parseFloat(fee) || 0);
  const valid = grossMinor > 0 && feeMinor >= 0 && feeMinor < grossMinor && !!fromId && !!bankId;

  async function submit() {
    setError(null);
    if (!valid) {
      setError(t('invalid'));
      return;
    }
    setSubmitting(true);
    try {
      const { data, error: apiError } = await apiPost<{ id: string }>(
        `/api/v1/stores/${storeId}/finance/payouts`,
        {
          fromAccountId: fromId,
          bankAccountId: bankId,
          grossMinor,
          feeMinor,
          postedAt: date ? new Date(`${date}T12:00:00Z`).toISOString() : undefined,
          reference: reference || undefined,
        }
      );
      if (apiError) {
        setError(apiError.message);
        return;
      }
      router.refresh();
      router.push(`/stores/${storeId}/finance/journal/${data?.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-2xl space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('from')}</span>
          <select
            value={fromId}
            onChange={e => setFromId(e.target.value)}
            className={FIELD_CLASSES}
          >
            <option value="">{t('select')}</option>
            {sources.map(a => (
              <option key={a.id} value={a.id}>
                {label(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('bank')}</span>
          <select
            value={bankId}
            onChange={e => setBankId(e.target.value)}
            className={FIELD_CLASSES}
          >
            <option value="">{t('select')}</option>
            {assets
              .filter(a => !SOURCE_CODES.includes(a.code))
              .map(a => (
                <option key={a.id} value={a.id}>
                  {label(a)}
                </option>
              ))}
          </select>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('gross')}</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={gross}
              onChange={e => setGross(e.target.value)}
              className={FIELD_CLASSES}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('fee')}</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={fee}
              onChange={e => setFee(e.target.value)}
              className={FIELD_CLASSES}
            />
          </label>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('net', { amount: ((grossMinor - feeMinor) / 100).toFixed(2) })}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('date')}</span>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className={FIELD_CLASSES}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('reference')}</span>
            <input
              type="text"
              maxLength={120}
              value={reference}
              onChange={e => setReference(e.target.value)}
              className={FIELD_CLASSES}
            />
          </label>
        </div>
        {error && <p className="text-sm text-destructive-ink">{error}</p>}
        <FormFooter
          primaryLabel={t('submit')}
          cancelHref={`/stores/${storeId}/finance/bank-reconciliation`}
          onPrimary={() => void submit()}
          saving={submitting}
          disabled={!valid}
        />
      </div>
    </AdminLayout>
  );
}
