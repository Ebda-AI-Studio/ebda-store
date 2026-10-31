'use client';

import { useState } from 'react';
import { apiPost } from '../../../../../../../lib/api';
import { useT } from '@/i18n/useT';

/**
 * Per-product language balance / revert button pair.
 *
 * Balance: calls the balance-description endpoint, which reads both the
 * name and description pairs and fills each thinner side from its richer
 * counterpart (EN→AR or AR→EN independently for each pair).
 * On success it writes all four fields back into the form via `onBalanced`
 * and flips their provenance chips to "ai".
 *
 * Revert: calls the revert-balance endpoint, which restores the originals
 * (name, nameAr, description, descriptionAr) snapshotted before the last
 * balance. On success it writes the restored values back via `onBalanced`.
 *
 * The component mirrors AiFieldBadge's pattern: apiPost + loading state +
 * failed state + bilingual labels/tooltips.
 */
export function BalanceDescriptionButton({
  storeId,
  productId,
  onBalanced,
}: {
  storeId?: string;
  productId?: string;
  /**
   * Called with (nameEn, nameAr, descriptionEn, descriptionAr) after a
   * successful balance OR revert.
   */
  onBalanced?: (
    nameEn: string,
    nameAr: string,
    descriptionEn: string,
    descriptionAr: string
  ) => void;
}) {
  const t = useT('products.edit');
  const [busyBalance, setBusyBalance] = useState(false);
  const [busyRevert, setBusyRevert] = useState(false);
  const [failedBalance, setFailedBalance] = useState(false);
  const [failedRevert, setFailedRevert] = useState(false);
  const [balanced, setBalanced] = useState(false);

  if (!storeId || !productId) return null;

  const SpinIcon = () => (
    <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );

  return (
    <div className="flex items-center gap-1.5">
      {/* Balance button */}
      <button
        type="button"
        disabled={busyBalance || busyRevert}
        onClick={async () => {
          setBusyBalance(true);
          setFailedBalance(false);
          const { data, error } = await apiPost<{
            balanced: boolean;
            sides: Record<string, string>;
            name: string;
            nameAr: string;
            description: string;
            descriptionAr: string;
          }>(`/api/v1/stores/${storeId}/ai/products/${productId}/ai/balance-description`, {});
          setBusyBalance(false);
          if (error || !data) {
            setFailedBalance(true);
            return;
          }
          setBalanced(true);
          onBalanced?.(data.name, data.nameAr, data.description, data.descriptionAr);
        }}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium disabled:opacity-50 transition-colors ${
          failedBalance
            ? 'bg-destructive/10 text-destructive-ink'
            : balanced
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary'
        }`}
        title={failedBalance ? t('balanceFailed') : t('balanceTitle')}
      >
        {busyBalance ? <SpinIcon /> : <span aria-hidden>⚖️</span>}
        <span>
          {busyBalance
            ? '…'
            : failedBalance
              ? t('retryWarn')
              : balanced
                ? t('balanced')
                : t('balanceLanguages')}
        </span>
      </button>

      {/* Revert button — only shown after a balance has been applied */}
      {balanced && (
        <button
          type="button"
          disabled={busyBalance || busyRevert}
          onClick={async () => {
            setBusyRevert(true);
            setFailedRevert(false);
            const { data, error } = await apiPost<{
              reverted: boolean;
              name: string;
              nameAr: string;
              description: string;
              descriptionAr: string;
            }>(`/api/v1/stores/${storeId}/ai/products/${productId}/ai/revert-balance`, {});
            setBusyRevert(false);
            if (error || !data) {
              setFailedRevert(true);
              return;
            }
            setBalanced(false);
            onBalanced?.(data.name, data.nameAr, data.description, data.descriptionAr);
          }}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium disabled:opacity-50 transition-colors ${
            failedRevert
              ? 'bg-destructive/10 text-destructive-ink'
              : 'bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive-ink'
          }`}
          title={failedRevert ? t('revertFailed') : t('revertTitle')}
        >
          {busyRevert ? <SpinIcon /> : null}
          <span>{busyRevert ? '…' : failedRevert ? t('retryWarn') : t('revert')}</span>
        </button>
      )}
    </div>
  );
}
