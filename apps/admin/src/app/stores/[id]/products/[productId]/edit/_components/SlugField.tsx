'use client';

import { Input } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { isValidProductSlug } from './slug-field';

/** Editable product link. Controlled; the edit page owns the single PUT (the API records the redirect on change). */
export function SlugField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT('products.edit.fields');
  const invalid = value.trim() !== '' && !isValidProductSlug(value);
  return (
    <div>
      <Input
        label={t('slug')}
        value={value}
        onChange={e => onChange(e.target.value)}
        dir="ltr"
        aria-describedby="product-slug-hint"
        error={invalid ? t('slugInvalid') : undefined}
      />
      <p id="product-slug-hint" className="mt-1 text-xs text-muted-foreground">
        {t('slugHint')}
      </p>
    </div>
  );
}
