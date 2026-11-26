'use client';

/**
 * FulfilmentCard: "made to order" lead time and the size guide for one product.
 *
 * Controlled and presentational: it only edits the page's form state. The edit page owns
 * the single PUT (one writer), so there is no save button here. Empty lead time = ready to
 * ship, which hides the made-to-order line on the storefront delivery chip. Empty size chart =
 * inherit the category's chart (B0 Task 9).
 */

import { Input } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { SizeChartSelect, type SizeChartOption } from '@/components/SizeChartSelect';

export const LEAD_TIME_MAX = 60;

interface Props {
  /** Raw input string: '' = ready to ship, otherwise integer business days. */
  value: string;
  onChange: (next: string) => void;
  storeId: string;
  sizeCharts: SizeChartOption[];
  /** '' = inherit the category's chart. */
  sizeChartId: string;
  onSizeChartChange: (next: string) => void;
}

export function FulfilmentCard({
  value,
  onChange,
  storeId,
  sizeCharts,
  sizeChartId,
  onSizeChartChange,
}: Props) {
  const t = useT('products.edit.fulfilment');
  return (
    <div className="rounded-md border bg-card p-6 shadow-sm">
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
      <div className="mt-4 max-w-sm">
        <SizeChartSelect
          kind="product"
          storeId={storeId}
          charts={sizeCharts}
          value={sizeChartId}
          onChange={onSizeChartChange}
        />
      </div>
    </div>
  );
}
