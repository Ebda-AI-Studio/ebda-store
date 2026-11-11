'use client';

import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { RETURN_FILTER_KEYS, type ReturnFilter } from './types';

interface ReturnStatusFilterProps {
  value: ReturnFilter;
  onChange: (value: ReturnFilter) => void;
}

/**
 * Pill-style filter bar for the returns list. Labels come from
 * `returns.filters.<key>` so the control is not coupled to English copy.
 */
export function ReturnStatusFilter({ value, onChange }: ReturnStatusFilterProps) {
  const t = useT('returns.filters');

  return (
    <div className="mb-6 flex gap-2">
      {RETURN_FILTER_KEYS.map(f => (
        <Button
          key={f}
          variant={value === f ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange(f)}
        >
          {t(f)}
        </Button>
      ))}
    </div>
  );
}
