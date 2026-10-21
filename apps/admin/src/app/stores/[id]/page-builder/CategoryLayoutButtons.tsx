'use client';

import { ModeButton } from './ModeButton';

export type CategoryLayoutValue = 'grid' | 'horizontal' | 'chips';

/** Grid / scrolling row / text chips: one button per layout, the stored value selected. */
export function CategoryLayoutButtons({
  value,
  onChange,
  t,
}: {
  value: CategoryLayoutValue;
  onChange: (v: CategoryLayoutValue) => void;
  t: (key: string) => string;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 mb-2">
      <ModeButton
        active={value === 'grid'}
        onClick={() => onChange('grid')}
        label={t('sections.categories.layoutGrid')}
      />
      <ModeButton
        active={value === 'horizontal'}
        onClick={() => onChange('horizontal')}
        label={t('sections.categories.layoutHorizontal')}
      />
      <ModeButton
        active={value === 'chips'}
        onClick={() => onChange('chips')}
        label={t('sections.categories.layoutChips')}
      />
    </div>
  );
}
