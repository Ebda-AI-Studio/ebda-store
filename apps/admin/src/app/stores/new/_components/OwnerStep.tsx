'use client';

import { Input } from '@force/ui';
import { useT } from '@/i18n/useT';
import type { FormData } from './types';

interface OwnerStepProps {
  formData: FormData;
  validationErrors: Record<string, string>;
  onFieldChange: (field: keyof FormData, value: string) => void;
}

export function OwnerStep({ formData, validationErrors, onFieldChange }: OwnerStepProps) {
  const t = useT('stores.new');

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-foreground">{t('step2Heading')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('step2Subtitle')}</p>

      <div className="mt-6 space-y-4">
        <div>
          <label htmlFor="ownerName" className="block text-sm font-medium text-foreground">
            {t('ownerNameLabel')} <span className="text-destructive-ink">{t('required')}</span>
          </label>
          <Input
            id="ownerName"
            value={formData.ownerName}
            onChange={e => onFieldChange('ownerName', e.target.value)}
            placeholder={t('ownerNamePlaceholder')}
            className={`mt-1 ${validationErrors.ownerName ? 'border-destructive' : ''}`}
          />
          {validationErrors.ownerName && (
            <p className="mt-1 text-sm text-destructive-ink">{validationErrors.ownerName}</p>
          )}
        </div>

        <div>
          <label htmlFor="ownerEmail" className="block text-sm font-medium text-foreground">
            {t('emailLabel')} <span className="text-destructive-ink">{t('required')}</span>
          </label>
          <Input
            id="ownerEmail"
            type="email"
            value={formData.ownerEmail}
            onChange={e => onFieldChange('ownerEmail', e.target.value)}
            placeholder={t('emailPlaceholder')}
            className={`mt-1 ${validationErrors.ownerEmail ? 'border-destructive' : ''}`}
          />
          {validationErrors.ownerEmail && (
            <p className="mt-1 text-sm text-destructive-ink">{validationErrors.ownerEmail}</p>
          )}
        </div>

        <div>
          <label htmlFor="ownerPassword" className="block text-sm font-medium text-foreground">
            {t('tempPasswordLabel')} <span className="text-destructive-ink">{t('required')}</span>
          </label>
          <Input
            id="ownerPassword"
            type="password"
            value={formData.ownerPassword}
            onChange={e => onFieldChange('ownerPassword', e.target.value)}
            placeholder={t('tempPasswordPlaceholder')}
            className={`mt-1 ${validationErrors.ownerPassword ? 'border-destructive' : ''}`}
          />
          {validationErrors.ownerPassword && (
            <p className="mt-1 text-sm text-destructive-ink">{validationErrors.ownerPassword}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{t('tempPasswordHint')}</p>
        </div>
      </div>
    </div>
  );
}
