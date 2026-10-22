'use client';

import { ModeButton } from './ModeButton';

export type CategoryLayoutValue = 'grid' | 'horizontal' | 'chips' | 'rail' | 'tiles';

/** Grid / scrolling row / text chips / image rail / square tiles: one button per layout (3 per row). */
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
      <ModeButton
        active={value === 'rail'}
        onClick={() => onChange('rail')}
        label={t('sections.categories.layoutRail')}
      />
      <ModeButton
        active={value === 'tiles'}
        onClick={() => onChange('tiles')}
        label={t('sections.categories.layoutTiles')}
      />
    </div>
  );
}
