'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import { apiPost } from '@/lib/api';
import { formatPrice, majorToMinor } from '@/lib/format';
import { Button } from '@/components/ui/Button';

interface WalletAdjustModalProps {
  open: boolean;
  storeId: string;
  customerId: string;
  balance: number;
  onClose: () => void;
  /** Called with the new balance after a successful (or replayed) adjustment. */
  onAdjusted: (balance: number) => void;
}

type Direction = 'credit' | 'debit';

/**
 * Manual wallet credit / debit (D1). The reason is REQUIRED — it is the
 * merchant's audit trail (also written to the audit log); the customer never
 * sees it. One idempotency key per open of the sheet, so a double-tap or a
 * retry after a network blip replays instead of moving money twice.
 */
export function WalletAdjustModal({
  open,
  storeId,
  customerId,
  balance,
  onClose,
  onAdjusted,
}: WalletAdjustModalProps) {
  const t = useT('customers.detail.wallet.modal');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const { success: toastSuccess, error: toastError } = useToast();
  const FORM_ID = 'wallet-adjust-form';

  const [direction, setDirection] = useState<Direction>('credit');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [requestKey, setRequestKey] = useState('');

  useEffect(() => {
    if (open) {
      setDirection('credit');
      setAmount('');
      setNote('');
      setError(null);
      setRequestKey(crypto.randomUUID());
    }
  }, [open]);

  const piastres = majorToMinor(amount);
  const signed = piastres === null ? null : direction === 'credit' ? piastres : -piastres;
  const preview = signed === null ? null : balance + signed;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (piastres === null || piastres <= 0) {
      setError(t('invalidAmount'));
      return;
    }
    if (!note.trim()) {
      setError(t('noteRequired'));
      return;
    }
    if (direction === 'debit' && piastres > balance) {
      setError(t('exceedsBalance'));
      return;
    }
    setError(null);
    setSaving(true);
    const { data, error: apiError } = await apiPost<{ balance: number }>(
      `/api/v1/stores/${storeId}/customers/${customerId}/wallet/adjustments`,
      { amount: signed, note: note.trim(), idempotencyKey: requestKey }
    );
    setSaving(false);
    if (apiError || !data) {
      const message =
        apiError?.code === 'INSUFFICIENT_WALLET_BALANCE' ? t('exceedsBalance') : t('failed');
      setError(message);
      toastError(t('failed'), message);
      return;
    }
    toastSuccess(
      t('successTitle'),
      t('newBalance', { amount: formatPrice(data.balance, { locale }) })
    );
    onAdjusted(data.balance);
    onClose();
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t('title')}
      footer={
        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" size="md" type="button" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="default" size="md" type="submit" form={FORM_ID} disabled={saving}>
            {saving && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            )}
            {t('submit')}
          </Button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t('currentBalance', { amount: formatPrice(balance, { locale }) })}
        </p>

        <fieldset>
          <legend className="block text-sm font-medium text-muted-foreground mb-2">
            {t('directionLabel')}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(['credit', 'debit'] as const).map(d => (
              <label
                key={d}
                className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 min-h-11 text-sm cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="radio"
                  name="walletDirection"
                  value={d}
                  checked={direction === d}
                  onChange={() => setDirection(d)}
                />
                {t(d)}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label
            htmlFor="wallet-adjust-amount"
            className="block text-sm font-medium text-muted-foreground mb-2"
          >
            {t('amountLabel')} <span className="text-destructive-ink">*</span>
          </label>
          <input
            id="wallet-adjust-amount"
            type="text"
            inputMode="decimal"
            dir="ltr"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder={t('amountPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            required
          />
          {preview !== null && piastres !== null && piastres > 0 && (
            <p
              className={`mt-1 text-xs ${preview < 0 ? 'text-destructive-ink' : 'text-muted-foreground'}`}
            >
              {t('newBalance', { amount: formatPrice(preview, { locale }) })}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="wallet-adjust-note"
            className="block text-sm font-medium text-muted-foreground mb-2"
          >
            {t('noteLabel')} <span className="text-destructive-ink">*</span>
          </label>
          <textarea
            id="wallet-adjust-note"
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder={t('notePlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
            required
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive-ink">
            {error}
          </p>
        )}
      </form>
    </BottomSheet>
  );
}
