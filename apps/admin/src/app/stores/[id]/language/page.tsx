'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { apiGet, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { TaxTimeZoneCard } from '../tax/_components/TaxTimeZoneCard';

type Language = 'en' | 'ar';

const OPTIONS: Array<{ id: Language; badge: string }> = [
  { id: 'ar', badge: 'ع' },
  { id: 'en', badge: 'EN' },
];

/**
 * "اللغة والمنطقة الزمنية": the storefront's default language and the store time zone (moved here from the tax
 * page, UX:TX-2). One sticky Save for the language; the time zone card saves its own single field.
 */
export default function LanguagePage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('language.page');
  const { success: toastSuccess, error: toastError } = useToast();

  const [defaultLanguage, setDefaultLanguage] = useState<Language>('en');
  const [savedLanguage, setSavedLanguage] = useState<Language>('en');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const { data } = await apiGet<{
        settings?: { defaultLanguage?: Language };
        store?: { settings?: { defaultLanguage?: Language } };
      }>(`/api/v1/stores/${storeId}`);
      const storeSettings = data?.settings || data?.store?.settings;
      const loaded = storeSettings?.defaultLanguage ?? 'en';
      setDefaultLanguage(loaded);
      setSavedLanguage(loaded);
    } catch (err) {
      console.error('Failed to fetch store settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function handleSave() {
    setIsSaving(true);
    try {
      // Only this page's key: the server merges `settings` against the live row.
      const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: { defaultLanguage },
      });
      if (!error) {
        setSavedLanguage(defaultLanguage);
        toastSuccess(t('successMessage'), '');
      } else {
        toastError(t('failedMessage'), error.message || '');
      }
    } catch {
      toastError(t('connectionError'), '');
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('title')}>
        <div className="animate-pulse space-y-4">
          <div className="h-40 rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="space-y-6 pb-24">
        <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
          <div>
            <h2 data-setting-id="language.default" className="font-semibold text-foreground">
              {t('defaultTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('defaultHint')}</p>
          </div>

          <div
            role="radiogroup"
            aria-label={t('defaultTitle')}
            className="grid gap-3 sm:grid-cols-2"
          >
            {OPTIONS.map(opt => {
              const selected = defaultLanguage === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setDefaultLanguage(opt.id)}
                  className={`flex min-h-11 items-center gap-3 rounded-xl border-2 p-4 transition-all ${
                    selected ? 'border-primary bg-primary/5' : 'border-border hover:border-input'
                  }`}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-foreground">
                    {opt.badge}
                  </span>
                  <div className="text-start">
                    <p className="font-medium text-foreground">
                      {opt.id === 'ar' ? t('arabicName') : t('englishName')}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {opt.id === 'ar' ? t('arabicLayout') : t('englishLayout')}
                    </p>
                  </div>
                  {selected && (
                    <svg
                      className="ms-auto h-5 w-5 text-primary"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <TaxTimeZoneCard storeId={storeId} />
      </div>
      <StickySaveBar
        dirty={defaultLanguage !== savedLanguage || isSaving}
        onSave={handleSave}
        onReset={() => setDefaultLanguage(savedLanguage)}
        saving={isSaving}
        saveLabel={t('save')}
      />
    </AdminLayout>
  );
}
