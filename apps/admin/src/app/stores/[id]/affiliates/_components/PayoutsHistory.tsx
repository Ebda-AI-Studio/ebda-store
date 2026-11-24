'use client';

import { useT } from '@/i18n/useT';
import { minorToMajor } from '@/lib/format';
import { formatFils, type Affiliate } from './types';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';

interface PayoutsHistoryProps {
  affiliate: Affiliate;
  amount: string;
  method: string;
  notes: string;
  saving: boolean;
  onAmountChange: (value: string) => void;
  onMethodChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

const PAYOUT_METHODS = ['bank_transfer', 'instapay', 'wallet', 'cash', 'manual'] as const;

/**
 * Payout creation modal. Collects amount (EGP), method, and optional notes
 * for a specific approved affiliate with a positive pending balance.
 */
export function PayoutsHistory({
  affiliate,
  amount,
  method,
  notes,
  saving,
  onAmountChange,
  onMethodChange,
  onNotesChange,
  onClose,
  onSubmit,
}: PayoutsHistoryProps) {
  const t = useT('affiliates.payout');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-md shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-semibold text-foreground">{t('title')}</h2>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            type="button"
            onClick={onClose}
            aria-label={t('close')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </Button>
        </div>

        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('summary.label')} <strong>{affiliate.name}</strong>. {t('summary.available')}{' '}
            <strong className="text-primary">{formatFils(Number(affiliate.pendingBalance))}</strong>
          </p>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('fields.amount')} <span className="text-destructive-ink">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={minorToMajor(Number(affiliate.pendingBalance))}
              value={amount}
              onChange={e => onAmountChange(e.target.value)}
              placeholder="0.00"
              className={FIELD_CLASSES}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('fields.method')}
            </label>
            <select
              value={method}
              onChange={e => onMethodChange(e.target.value)}
              className={FIELD_CLASSES}
            >
              {PAYOUT_METHODS.map(m => (
                <option key={m} value={m}>
                  {t(`methods.${m}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('fields.notes')}
            </label>
            <textarea
              value={notes}
              onChange={e => onNotesChange(e.target.value)}
              placeholder={t('fields.notesPlaceholder')}
              rows={3}
              className={`${TEXTAREA_CLASSES} resize-none`}
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4">
            <Button variant="outline" size="md" type="button" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button variant="default" size="md" type="submit" disabled={saving || !amount}>
              {saving && (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              )}
              {t('confirm')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
