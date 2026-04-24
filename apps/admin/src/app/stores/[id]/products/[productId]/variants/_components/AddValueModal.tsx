'use client';

import { Button, Input, Label } from '@force/ui';
import { useT } from '@/i18n/useT';

interface AddValueModalProps {
  value: string;
  valueAr: string;
  onValueChange: (next: string) => void;
  onValueArChange: (next: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function AddValueModal({
  value,
  valueAr,
  onValueChange,
  onValueArChange,
  onCancel,
  onSubmit,
}: AddValueModalProps) {
  const t = useT('products.variants.valueModal');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl bg-card p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h3>

        <div className="space-y-4">
          <div>
            <Label htmlFor="newValue">{t('valueLabel')}</Label>
            <Input
              id="newValue"
              value={value}
              onChange={e => onValueChange(e.target.value)}
              placeholder={t('valuePlaceholder')}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="newValueAr">{t('valueArLabel')}</Label>
            <Input
              id="newValueAr"
              value={valueAr}
              onChange={e => onValueArChange(e.target.value)}
              dir="rtl"
              className="mt-1"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button onClick={onSubmit}>{t('submit')}</Button>
        </div>
      </div>
    </div>
  );
}
