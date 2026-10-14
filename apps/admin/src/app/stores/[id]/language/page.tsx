'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';

type Language = 'en' | 'ar';

export default function LanguagePage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('language.page');

  const [defaultLanguage, setDefaultLanguage] = useState<Language>('en');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchSettings = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const { data } = await apiGet<{
        settings?: { defaultLanguage?: Language };
        store?: { settings?: { defaultLanguage?: Language } };
      }>(`/api/v1/stores/${storeId}`);
      const storeSettings = data?.settings || data?.store?.settings;
      if (storeSettings?.defaultLanguage) {
        setDefaultLanguage(storeSettings.defaultLanguage);
      }
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
    setMessage(null);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: { defaultLanguage },
      });

      if (!error) {
        setMessage({ type: 'success', text: t('successMessage') });
      } else {
        setMessage({
          type: 'error',
          text: error.message || t('failedMessage'),
        });
      }
    } catch {
      setMessage({ type: 'error', text: t('connectionError') });
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('title')} subtitle={t('loading')}>
        <div className="animate-pulse space-y-4">
          <div className="h-40 rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}/settings`}>
            <Button type="button" variant="outline">
              {t('backToSettings')}
            </Button>
          </Link>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {isSaving ? t('saving') : t('save')}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div>
            <h2 className="font-semibold text-foreground">{t('defaultTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('defaultHint')}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setDefaultLanguage('en')}
              className={`flex items-center gap-3 rounded-xl border-2 p-4 transition-all ${
                defaultLanguage === 'en'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-border'
              }`}
            >
              <span className="text-2xl">🇬🇧</span>
              <div className="text-start">
                <p className="font-medium text-foreground">{t('englishName')}</p>
                <p className="text-sm text-muted-foreground">{t('englishLayout')}</p>
              </div>
              {defaultLanguage === 'en' && (
                <svg
                  className="ms-auto h-5 w-5 text-primary"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>

            <button
              type="button"
              onClick={() => setDefaultLanguage('ar')}
              className={`flex items-center gap-3 rounded-xl border-2 p-4 transition-all ${
                defaultLanguage === 'ar'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-border'
              }`}
            >
              <span className="text-2xl">🇰🇼</span>
              <div className="text-start">
                <p className="font-medium text-foreground">{t('arabicName')}</p>
                <p className="text-sm text-muted-foreground">{t('arabicLayout')}</p>
              </div>
              {defaultLanguage === 'ar' && (
                <svg
                  className="ms-auto h-5 w-5 text-primary"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>

        {message && (
          <div
            className={`rounded-xl p-4 text-sm ${
              message.type === 'success'
                ? 'bg-success/10 border border-success/20 text-success-ink'
                : 'bg-destructive/10 border border-destructive/20 text-destructive-ink'
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
