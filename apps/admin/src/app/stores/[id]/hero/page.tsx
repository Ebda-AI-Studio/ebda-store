'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ImageUpload } from '../../../../components/ImageUpload';
import { useToast } from '@force/ui';
import { apiPut } from '../../../../lib/api';
import { useCurrentStore } from '../../../../hooks/useCurrentStore';
import { useT } from '@/i18n/useT';

// Narrow slice of the store record consumed by this page. The shared
// useCurrentStore hook returns a superset; we mirror state locally so the
// user can edit fields without mutating the cached store object.
interface StoreHero {
  id: string;
  name: string;
  heroTitle?: string | null;
  heroTitleAr?: string | null;
  heroSubtitle?: string | null;
  heroSubtitleAr?: string | null;
  heroCtaText?: string | null;
  heroCtaTextAr?: string | null;
  heroCtaLink?: string | null;
  heroImage?: string | null;
}

export default function StoreHeroPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const toast = useToast();
  const t = useT('hero.page');

  const { store, isLoading, error: loadError } = useCurrentStore(storeId);
  const [hero, setHero] = useState<StoreHero | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Seed local edit state once the store is fetched/cached.
  useEffect(() => {
    if (store) {
      setHero({
        id: store.id,
        name: store.name,
        heroTitle: store.heroTitle ?? '',
        heroTitleAr: store.heroTitleAr ?? '',
        heroSubtitle: store.heroSubtitle ?? '',
        heroSubtitleAr: store.heroSubtitleAr ?? '',
        heroCtaText: store.heroCtaText ?? '',
        heroCtaTextAr: store.heroCtaTextAr ?? '',
        heroCtaLink: store.heroCtaLink ?? '',
        heroImage: store.heroImage ?? '',
      });
    }
  }, [store]);

  useEffect(() => {
    if (loadError) {
      toast.error(t('toastLoadFailedTitle'), loadError.message);
    }
  }, [loadError, toast, t]);

  async function handleSave() {
    if (!hero) return;
    setIsSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
        heroTitle: hero.heroTitle || null,
        heroTitleAr: hero.heroTitleAr || null,
        heroSubtitle: hero.heroSubtitle || null,
        heroSubtitleAr: hero.heroSubtitleAr || null,
        heroCtaText: hero.heroCtaText || null,
        heroCtaTextAr: hero.heroCtaTextAr || null,
        heroCtaLink: hero.heroCtaLink || null,
        heroImage: hero.heroImage || null,
      });

      if (error) {
        if (error.status === 403) {
          toast.error(t('toastAccessDeniedTitle'), t('toastAccessDeniedBody'));
        } else if (error.status === 401) {
          toast.error(t('toastSessionExpiredTitle'), t('toastSessionExpiredBody'));
        } else {
          toast.error(t('toastSaveFailedTitle'), error.message || 'Server error');
        }
        return;
      }

      toast.success(t('toastSavedTitle'), t('toastSavedBody'));
    } catch (err) {
      console.error('Failed to save hero:', err);
      toast.error(t('toastConnectionTitle'), t('toastSaveConnectionBody'));
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </AdminLayout>
    );
  }

  if (!hero) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
        <div className="text-center py-12">
          <p className="text-muted-foreground">{t('storeNotFound')}</p>
          <Link href="/stores" className="text-primary hover:underline mt-2 inline-block">
            {t('backToStores')}
          </Link>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      mode="store_admin"
      storeId={storeId}
      actions={
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
        >
          {isSaving ? t('saving') : t('saveChanges')}
        </button>
      }
    >
      <div className="space-y-6">
        <div className="bg-card rounded-xl border p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('titleEnglish')}
              </label>
              <input
                type="text"
                value={hero.heroTitle || ''}
                onChange={e => setHero({ ...hero, heroTitle: e.target.value })}
                placeholder={t('titleEnglishPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('titleArabic')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={hero.heroTitleAr || ''}
                onChange={e => setHero({ ...hero, heroTitleAr: e.target.value })}
                placeholder={t('titleArabicPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('subtitleEnglish')}
              </label>
              <textarea
                value={hero.heroSubtitle || ''}
                onChange={e => setHero({ ...hero, heroSubtitle: e.target.value })}
                rows={3}
                placeholder={t('subtitleEnglishPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('subtitleArabic')}
              </label>
              <textarea
                dir="rtl"
                value={hero.heroSubtitleAr || ''}
                onChange={e => setHero({ ...hero, heroSubtitleAr: e.target.value })}
                rows={3}
                placeholder={t('subtitleArabicPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('ctaEnglish')}
              </label>
              <input
                type="text"
                value={hero.heroCtaText || ''}
                onChange={e => setHero({ ...hero, heroCtaText: e.target.value })}
                placeholder={t('ctaEnglishPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('ctaArabic')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={hero.heroCtaTextAr || ''}
                onChange={e => setHero({ ...hero, heroCtaTextAr: e.target.value })}
                placeholder={t('ctaArabicPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('ctaLink')}
              </label>
              <input
                type="text"
                value={hero.heroCtaLink || ''}
                onChange={e => setHero({ ...hero, heroCtaLink: e.target.value })}
                placeholder={t('ctaLinkPlaceholder')}
                className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('heroImage')}
            </label>
            <ImageUpload
              value={hero.heroImage || undefined}
              onUpload={url => setHero({ ...hero, heroImage: url })}
              onRemove={() => setHero({ ...hero, heroImage: '' })}
              folder="hero"
              label={t('uploadHeroImage')}
              accept="image/jpeg,image/png,image/webp"
            />
            <p className="mt-2 text-xs text-muted-foreground">{t('heroImageHint')}</p>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
