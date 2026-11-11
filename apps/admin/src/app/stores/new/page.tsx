'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../components/AdminLayout';
import { apiPost } from '../../../lib/api';
import { isValidEmail, slugify, validateStoreSlug } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { StepIndicator } from './_components/StepIndicator';
import { StoreDetailsStep } from './_components/StoreDetailsStep';
import { OwnerStep } from './_components/OwnerStep';
import { ReviewStep } from './_components/ReviewStep';
import { SuccessScreen } from './_components/SuccessScreen';
import type {
  CreatedOwner,
  CreatedStore,
  FormData as NewStoreFormData,
  Step,
} from './_components/types';

const STEP_ORDER: Step[] = ['store', 'owner', 'review'];

export default function CreateStorePage() {
  const t = useT('stores.new');
  const [currentStep, setCurrentStep] = useState<Step>('store');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ store: CreatedStore; owner: CreatedOwner } | null>(null);

  const [formData, setFormData] = useState<NewStoreFormData>({
    storeName: '',
    storeSlug: '',
    customDomain: '',
    ownerEmail: '',
    ownerName: '',
    ownerPassword: '',
  });

  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  function handleNameChange(value: string) {
    setFormData(prev => ({
      ...prev,
      storeName: value,
      storeSlug: slugify(value, { ascii: true, max: 40 }),
    }));
    setValidationErrors(prev => ({ ...prev, storeName: '', storeSlug: '' }));
  }

  function handleFieldChange(field: keyof NewStoreFormData, value: string) {
    setFormData(prev => ({ ...prev, [field]: value }));
    setValidationErrors(prev => ({ ...prev, [field]: '' }));
  }

  function validateStep(step: Step): boolean {
    const errors: Record<string, string> = {};

    if (step === 'store') {
      if (!formData.storeName.trim()) errors.storeName = t('errors.storeNameRequired');
      if (!formData.storeSlug.trim()) errors.storeSlug = t('errors.storeUrlRequired');
      if (formData.storeSlug) {
        // Same rules the API enforces (@ebda/shared): format, 3-40 chars, and
        // not a reserved label (`app`, `api`, `www`, …).
        // Protected brand names are decided by the API (a super_admin may claim them).
        const slugCheck = validateStoreSlug(formData.storeSlug, { allowProtected: true });
        if (!slugCheck.ok) {
          errors.storeSlug =
            slugCheck.code === 'SLUG_RESERVED'
              ? t('errors.storeUrlReserved')
              : slugCheck.code === 'SLUG_TOO_SHORT' || slugCheck.code === 'SLUG_TOO_LONG'
                ? t('errors.storeUrlLength')
                : t('errors.storeUrlInvalid');
        }
      }
    }

    if (step === 'owner') {
      if (!formData.ownerEmail.trim()) errors.ownerEmail = t('errors.emailRequired');
      if (formData.ownerEmail && !isValidEmail(formData.ownerEmail)) {
        errors.ownerEmail = t('errors.emailInvalid');
      }
      if (!formData.ownerName.trim()) errors.ownerName = t('errors.ownerNameRequired');
      if (!formData.ownerPassword) errors.ownerPassword = t('errors.passwordRequired');
      if (formData.ownerPassword && formData.ownerPassword.length < 8) {
        errors.ownerPassword = t('errors.passwordTooShort');
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function nextStep() {
    if (!validateStep(currentStep)) return;
    const stepIndex = STEP_ORDER.indexOf(currentStep);
    if (stepIndex < STEP_ORDER.length - 1) {
      setCurrentStep(STEP_ORDER[stepIndex + 1]);
    }
  }

  function prevStep() {
    const stepIndex = STEP_ORDER.indexOf(currentStep);
    if (stepIndex > 0) {
      setCurrentStep(STEP_ORDER[stepIndex - 1]);
    }
  }

  async function handleSubmit() {
    if (!validateStep('owner')) {
      setCurrentStep('owner');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = {
        storeName: formData.storeName,
        storeSlug: formData.storeSlug,
        ownerEmail: formData.ownerEmail,
        ownerName: formData.ownerName,
        ownerPassword: formData.ownerPassword,
        domain: formData.customDomain || undefined,
      };
      const { data, error: apiError } = await apiPost<{
        store: CreatedStore;
        owner: CreatedOwner;
      }>('/api/v1/admin/stores', payload);

      if (apiError) {
        throw new Error(apiError.message || t('errors.createFailed'));
      }

      if (data) {
        setSuccess({ store: data.store, owner: data.owner });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  }

  const currentStepIndex = STEP_ORDER.indexOf(currentStep);

  // Success Screen
  if (success) {
    return <SuccessScreen store={success.store} owner={success.owner} />;
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="mx-auto max-w-3xl">
        <StepIndicator currentStep={currentStep} onJumpTo={setCurrentStep} />

        {/* Step Content */}
        <div className="rounded-xl border bg-card shadow-sm">
          {currentStep === 'store' && (
            <StoreDetailsStep
              formData={formData}
              validationErrors={validationErrors}
              onNameChange={handleNameChange}
              onSlugChange={value => handleFieldChange('storeSlug', value)}
              onDomainChange={value => handleFieldChange('customDomain', value)}
            />
          )}
          {currentStep === 'owner' && (
            <OwnerStep
              formData={formData}
              validationErrors={validationErrors}
              onFieldChange={handleFieldChange}
            />
          )}
          {currentStep === 'review' && (
            <ReviewStep formData={formData} error={error} onJumpTo={setCurrentStep} />
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between border-t bg-muted px-6 py-4">
            {currentStepIndex === 0 ? (
              <Link
                href="/stores"
                className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                {t('cancel')}
              </Link>
            ) : (
              <Button type="button" variant="outline" onClick={prevStep}>
                {t('back')}
              </Button>
            )}

            {currentStep === 'review' ? (
              <Button onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <svg className="me-2 h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    {t('creating')}
                  </>
                ) : (
                  t('createBtn')
                )}
              </Button>
            ) : (
              <Button onClick={nextStep}>{t('continueBtn')}</Button>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
