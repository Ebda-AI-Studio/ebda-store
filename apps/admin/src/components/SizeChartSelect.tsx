'use client';

/**
 * Size-chart picker (B0 Task 9), shared by the product edit FulfilmentCard and the category form.
 * Controlled: the parent owns the value ('' = no own chart) and the single PUT. Products default to
 * "From category" (inherit); categories to "None".
 */

import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Select } from '@ebda/ui';
import { sizeChartName } from '@ebda/shared';
import { useT } from '@/i18n/useT';

export interface SizeChartOption {
  id: string;
  name: string;
  nameAr: string;
}

interface Props {
  storeId: string;
  charts: SizeChartOption[];
  /** '' = none / inherit. */
  value: string;
  onChange: (next: string) => void;
  /** 'product' → empty option reads "From category"; 'category' → "None". */
  kind: 'product' | 'category';
}

export function SizeChartSelect({ storeId, charts, value, onChange, kind }: Props) {
  const t = useT('sizeCharts.picker');
  const lang = useLocale() === 'en' ? 'en' : 'ar';
  const options = [
    { value: '', label: kind === 'product' ? t('inherit') : t('none') },
    ...charts.map(c => ({ value: c.id, label: sizeChartName(c, lang) })),
  ];
  return (
    <div>
      <Select
        label={t('label')}
        value={value}
        onChange={e => onChange(e.target.value)}
        options={options}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        {kind === 'product' ? t('productHint') : t('categoryHint')}{' '}
        <Link href={`/stores/${storeId}/size-charts`} className="text-primary hover:underline">
          {t('manage')}
        </Link>
      </p>
    </div>
  );
}
