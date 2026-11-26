'use client';

import { Input } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { STORE_HOST_SUFFIX } from '@/lib/store-url';
import type { FormData } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface StoreDetailsStepProps {
  formData: FormData;
  validationErrors: Record<string, string>;
  onNameChange: (value: string) => void;
  onSlugChange: (value: string) => void;
  onDomainChange: (value: string) => void;
}

export function StoreDetailsStep({
  formData,
  validationErrors,
  onNameChange,
  onSlugChange,
  onDomainChange,
}: StoreDetailsStepProps) {
  const t = useT('stores.new');

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-foreground">{t('step1Heading')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('step1Subtitle')}</p>

      <div className="mt-6 space-y-4">
        <div>
          <label htmlFor="storeName" className="block text-sm font-medium text-foreground">
            {t('storeNameLabel')} <span className="text-destructive-ink">{t('required')}</span>
          </label>
          <Input
            id="storeName"
            value={formData.storeName}
            onChange={e => onNameChange(e.target.value)}
            placeholder={t('storeNamePlaceholder')}
            className={`mt-1 ${validationErrors.storeName ? 'border-destructive' : ''}`}
          />
          {validationErrors.storeName && (
            <p className="mt-1 text-sm text-destructive-ink">{validationErrors.storeName}</p>
          )}
        </div>

        <div>
          <label htmlFor="storeSlug" className="block text-sm font-medium text-foreground">
            {t('storeSlugLabel')} <span className="text-destructive-ink">{t('required')}</span>
          </label>
          <div
            className={`mt-1 flex rounded-lg border overflow-hidden ${validationErrors.storeSlug ? 'border-destructive' : ''}`}
          >
            <input
              id="storeSlug"
              type="text"
              dir="ltr"
              value={formData.storeSlug}
              onChange={e => onSlugChange(e.target.value.toLowerCase())}
              placeholder={t('storeSlugPlaceholder')}
              className={`${FIELD_CLASSES} flex-1`}
            />
            <span
              dir="ltr"
              className="flex items-center bg-muted px-3 text-sm text-muted-foreground border-s"
            >
              {STORE_HOST_SUFFIX}
            </span>
          </div>
          {validationErrors.storeSlug && (
            <p className="mt-1 text-sm text-destructive-ink">{validationErrors.storeSlug}</p>
          )}
        </div>

        <div>
          <label htmlFor="customDomain" className="block text-sm font-medium text-foreground">
            {t('customDomainLabel')}{' '}
            <span className="text-xs text-muted-foreground">{t('customDomainOptional')}</span>
          </label>
          <Input
            id="customDomain"
            value={formData.customDomain}
            onChange={e => onDomainChange(e.target.value.toLowerCase())}
            placeholder={t('customDomainPlaceholder')}
            className="mt-1"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('customDomainHint')}</p>
        </div>
      </div>
    </div>
  );
}
