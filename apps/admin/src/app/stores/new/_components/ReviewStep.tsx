'use client';

import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { getPlatformStoreUrl } from '@/lib/store-url';
import type { FormData, Step } from './types';

interface ReviewStepProps {
  formData: FormData;
  error: string | null;
  onJumpTo: (step: Step) => void;
}

export function ReviewStep({ formData, error, onJumpTo }: ReviewStepProps) {
  const t = useT('stores.new');

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-foreground">{t('step3Heading')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('step3Subtitle')}</p>

      <div className="mt-6 space-y-6">
        <div className="rounded-lg bg-muted p-4">
          <h3 className="flex items-center justify-between font-medium text-foreground">
            {t('storeDetails')}
            <Button variant="link" size="sm" type="button" onClick={() => onJumpTo('store')}>
              {t('edit')}
            </Button>
          </h3>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t('reviewStoreName')}</dt>
              <dd className="font-medium">{formData.storeName}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t('reviewStoreUrl')}</dt>
              <dd className="font-medium">{getPlatformStoreUrl(formData.storeSlug)}</dd>
            </div>
            {formData.customDomain && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('reviewCustomDomain')}</dt>
                <dd className="font-medium">{formData.customDomain}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="rounded-lg bg-muted p-4">
          <h3 className="flex items-center justify-between font-medium text-foreground">
            {t('stepOwnerName')}
            <Button variant="link" size="sm" type="button" onClick={() => onJumpTo('owner')}>
              {t('edit')}
            </Button>
          </h3>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t('reviewOwnerName')}</dt>
              <dd className="font-medium">{formData.ownerName}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t('reviewOwnerEmail')}</dt>
              <dd className="font-medium">{formData.ownerEmail}</dd>
            </div>
          </dl>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-lg bg-destructive/10 p-4 text-sm text-destructive-ink">
          {error}
        </div>
      )}
    </div>
  );
}
