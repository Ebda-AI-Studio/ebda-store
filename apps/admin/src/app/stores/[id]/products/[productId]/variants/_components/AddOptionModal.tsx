'use client';

import { Button, Input, Label } from '@force/ui';
import { useT } from '@/i18n/useT';

interface AddOptionModalProps {
  name: string;
  nameAr: string;
  values: string;
  onNameChange: (value: string) => void;
  onNameArChange: (value: string) => void;
  onValuesChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function AddOptionModal({
  name,
  nameAr,
  values,
  onNameChange,
  onNameArChange,
  onValuesChange,
  onCancel,
  onSubmit,
}: AddOptionModalProps) {
  const t = useT('products.variants.optionModal');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl bg-card p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h3>

        <div className="space-y-4">
          <div>
            <Label htmlFor="optionName">{t('nameLabel')}</Label>
            <Input
              id="optionName"
              value={name}
              onChange={e => onNameChange(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="optionNameAr">{t('nameArLabel')}</Label>
            <Input
              id="optionNameAr"
              value={nameAr}
              onChange={e => onNameArChange(e.target.value)}
              placeholder={t('nameArPlaceholder')}
              lang="ar"
              dir="rtl"
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="optionValues">{t('valuesLabel')}</Label>
            <Input
              id="optionValues"
              value={values}
              onChange={e => onValuesChange(e.target.value)}
              placeholder={t('valuesPlaceholder')}
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
