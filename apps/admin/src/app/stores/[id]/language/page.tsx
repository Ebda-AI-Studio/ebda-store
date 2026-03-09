'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { getApiUrl } from '../../../../lib/api';

type Language = 'en' | 'ar';

const API_URL = getApiUrl();

export default function LanguagePage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [defaultLanguage, setDefaultLanguage] = useState<Language>('en');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchSettings = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${API_URL}/api/v1/stores/${storeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const settings = data.data?.settings || data.data?.store?.settings;
        if (settings?.defaultLanguage) {
          setDefaultLanguage(settings.defaultLanguage);
        }
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
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${API_URL}/api/v1/stores/${storeId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ settings: { defaultLanguage } }),
      });

      if (res.ok) {
        setMessage({ type: 'success', text: 'Language settings saved successfully' });
      } else {
        const errData = await res.json().catch(() => ({}));
        setMessage({
          type: 'error',
          text: errData.error?.message || 'Failed to save language settings',
        });
      }
    } catch {
      setMessage({ type: 'error', text: 'Unable to connect to the server' });
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title="Language Settings" subtitle="Loading...">
        <div className="animate-pulse space-y-4">
          <div className="h-40 rounded-xl bg-gray-200" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Language Settings"
      subtitle="Set the default language for your storefront"
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}/settings`}>
            <button className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 font-medium">
              Back to Settings
            </button>
          </Link>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
          <div>
            <h2 className="font-semibold text-gray-900">Default Storefront Language</h2>
            <p className="mt-1 text-sm text-gray-500">
              New visitors will see the storefront in this language. They can still switch languages
              manually.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setDefaultLanguage('en')}
              className={`flex items-center gap-3 rounded-xl border-2 p-4 transition-all ${
                defaultLanguage === 'en'
                  ? 'border-primary bg-primary/5'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <span className="text-2xl">🇬🇧</span>
              <div className="text-left">
                <p className="font-medium text-gray-900">English</p>
                <p className="text-sm text-gray-500">Left-to-right layout</p>
              </div>
              {defaultLanguage === 'en' && (
                <svg
                  className="ml-auto h-5 w-5 text-primary"
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
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <span className="text-2xl">🇰🇼</span>
              <div className="text-left">
                <p className="font-medium text-gray-900">العربية</p>
                <p className="text-sm text-gray-500">Right-to-left layout</p>
              </div>
              {defaultLanguage === 'ar' && (
                <svg
                  className="ml-auto h-5 w-5 text-primary"
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
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
