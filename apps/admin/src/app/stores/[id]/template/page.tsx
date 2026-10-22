'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { AdminSkeletonDetail } from '../../../../components/AdminSkeleton';
import { apiGet, apiPut } from '../../../../lib/api';
import { useLocale } from 'next-intl';
import { getLook, type LookId } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { LookPicker } from '../../../../components/looks/LookPicker';
import {
  LookSwitchDialog,
  type LookDesignChoice,
} from '../../../../components/looks/LookSwitchDialog';

const SKIN_IDS = ['modern', 'classic', 'minimal', 'bold', 'elegant', 'dahab'];
// Qamar and Souq are reached only through a look (Rulings B1-17, B2-1): labelled, never a bare
// skin choice.
const SKIN_LABEL_IDS = [...SKIN_IDS, 'qamar', 'souq'];

export default function StoreTemplatePage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('template.page');

  const skinName = (id: string) => (SKIN_LABEL_IDS.includes(id) ? t(`skins.${id}`) : id);
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [store, setStore] = useState<{
    name: string;
    template: string;
    look: LookId | null;
  } | null>(null);
  const [pending, setPending] = useState<LookId | null>(null);
  const [result, setResult] = useState<'draft' | 'published' | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState<'invalid' | 'generic' | null>(null);

  // Cancellation flag prevents setState after unmount if the user navigates away mid-request.
  useEffect(() => {
    let cancelled = false;
    async function fetchStore() {
      try {
        const { data } = await apiGet<{
          store: { name: string; template?: string; look?: string | null };
        }>(`/api/v1/stores/${storeId}`);
        if (cancelled) return;
        if (data?.store) {
          setStore({
            name: data.store.name,
            template: data.store.template || 'modern',
            look: getLook(data.store.look)?.id ?? null,
          });
        }
      } catch (error) {
        console.error('Failed to fetch store:', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    fetchStore();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  async function handleConfirm(design: LookDesignChoice) {
    if (!pending) return;
    setIsSaving(true);
    setSaveFailed(null);
    try {
      const { data, error } = await apiPut<{
        look: LookId;
        template: string;
        builder: 'published' | 'draft';
      }>(`/api/v1/stores/${storeId}/look`, { lookId: pending, design });
      if (error || !data) {
        setSaveFailed(error?.code === 'INVALID_LOOK' ? 'invalid' : 'generic');
        return;
      }
      setStore(prev => (prev ? { ...prev, look: data.look, template: data.template } : prev));
      setResult(data.builder);
      setPending(null);
    } catch (err) {
      console.error('Failed to switch look:', err);
      setSaveFailed('generic');
    } finally {
      setIsSaving(false);
    }
  }

  // Loading + not-found render INSIDE <AdminLayout> so the sidebar, hub tabs
  // and topbar stay mounted — an early return before the layout made the
  // whole admin chrome vanish and reappear (audit 2026-09-30 §8, fixed as a
  // class across every admin page).
  if (isLoading || !store) {
    return (
      <AdminLayout title={t('title')}>
        {isLoading ? (
          <AdminSkeletonDetail showHeader={false} />
        ) : (
          <div className="text-center py-12">
            <p className="text-muted-foreground">{t('storeNotFound')}</p>
            <Link href="/stores" className="text-primary hover:underline mt-2 inline-block">
              {t('backToStores')}
            </Link>
          </div>
        )}
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitleWithStore', { storeName: store.name })}
      actions={
        <Link
          href={`/stores/${storeId}`}
          className="inline-flex min-h-11 items-center px-4 py-2 border border-border rounded-lg hover:bg-muted"
        >
          {t('cancel')}
        </Link>
      }
    >
      <div className="space-y-6">
        {!store.look && (
          <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm" role="note">
            <p data-testid="legacy-skin" className="font-medium text-foreground">
              {t('legacySkin', { skin: skinName(store.template) })}
            </p>
            <p className="mt-1 text-muted-foreground">{t('legacyNote')}</p>
          </div>
        )}

        {result && (
          <div
            role="status"
            className="rounded-xl border border-success/30 bg-success/5 p-4 text-sm"
          >
            <p className="font-medium text-foreground">
              {result === 'draft' ? t('draftReady') : t('published')}
            </p>
            {result === 'draft' && (
              <Link
                href={`/stores/${storeId}/builder`}
                className="mt-2 inline-flex min-h-11 items-center text-primary-ink underline"
              >
                {t('openBuilder')}
              </Link>
            )}
          </div>
        )}

        {saveFailed && (
          <p role="alert" className="text-sm text-destructive-ink">
            {saveFailed === 'invalid' ? t('invalidLook') : t('saveError')}
          </p>
        )}

        <LookPicker
          value={store.look}
          locale={locale}
          onChange={id => {
            setSaveFailed(null);
            setResult(null);
            setPending(id);
          }}
        />

        {pending && (
          <LookSwitchDialog
            lookName={locale === 'ar' ? getLook(pending)!.name.ar : getLook(pending)!.name.en}
            saving={isSaving}
            onCancel={() => setPending(null)}
            onConfirm={handleConfirm}
          />
        )}

        {/* Help Text */}
        <div className="bg-info/5 border border-info/30 rounded-xl p-4">
          <div className="flex gap-3">
            <svg
              className="w-5 h-5 text-info shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div>
              <p className="text-info-ink font-medium">{t('aboutTitle')}</p>
              <p className="text-info-ink text-sm mt-1">
                {t('aboutBody')}
                <Link href={`/stores/${storeId}/branding`} className="underline ms-1">
                  {t('brandingSettings')}
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
