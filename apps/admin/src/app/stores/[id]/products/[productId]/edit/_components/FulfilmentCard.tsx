'use client';

/**
 * FulfilmentCard: "made to order" lead time for one product.
 *
 * Controlled and presentational: it only edits the page's form state. The edit page owns
 * the single PUT (one writer), so there is no save button here. Empty = ready to ship,
 * which hides the made-to-order line on the storefront delivery chip.
 */

import { Input } from '@ebda/ui';
import { useT } from '@/i18n/useT';

export const LEAD_TIME_MAX = 60;

interface Props {
  /** Raw input string: '' = ready to ship, otherwise integer business days. */
  value: string;
  onChange: (next: string) => void;
}

export function FulfilmentCard({ value, onChange }: Props) {
  const t = useT('products.edit.fulfilment');
  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="max-w-[240px]">
        <Input
          label={t('leadTime')}
          type="number"
          inputMode="numeric"
          min={0}
          max={LEAD_TIME_MAX}
          step={1}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={t('placeholder')}
        />
      </div>
    </div>
  );
}
