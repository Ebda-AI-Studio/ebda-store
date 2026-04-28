'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { BrandingIdentityTab } from './_components/BrandingIdentityTab';
import { BrandingTabs } from './_components/BrandingTabs';
import { ContactInfoTab } from './_components/ContactInfoTab';
import { SocialLinksTab } from './_components/SocialLinksTab';
import { ThemeTab } from './_components/ThemeTab';
import type { BrandingTabId } from './_components/types';
import { useBranding } from './_hooks/useBranding';

export default function StoreBrandingPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const tPage = useT('branding.page');
  const tActions = useT('branding.actions');
  const tMessages = useT('branding.messages');
  const tTabs = useT('branding.tabs');

  const [activeTab, setActiveTab] = useState<BrandingTabId>('branding');

  // Memoize so the hook's callback identity is stable across renders.
  const toastMessages = useMemo(
    () => ({
      loadFailedTitle: tMessages('loadFailedTitle'),
      connectionErrorTitle: tMessages('connectionErrorTitle'),
      connectionErrorBody: tMessages('connectionErrorBody'),
      connectionErrorSaveBody: tMessages('connectionErrorSaveBody'),
      serverErrorPrefix: tMessages('serverErrorPrefix'),
      accessDeniedTitle: tMessages('accessDeniedTitle'),
      accessDeniedBody: tMessages('accessDeniedBody'),
      sessionExpiredTitle: tMessages('sessionExpiredTitle'),
      sessionExpiredBody: tMessages('sessionExpiredBody'),
      saveFailedPrefix: tMessages('saveFailedPrefix'),
      serverError: tMessages('serverError'),
      saveSuccessTitle: tMessages('saveSuccessTitle'),
      saveSuccessBody: tMessages('saveSuccessBody'),
      sectionBranding: tTabs('branding'),
      sectionTheme: tTabs('theme'),
      sectionContact: tTabs('contact'),
      sectionSocial: tTabs('social'),
    }),
    [tMessages, tTabs]
  );

  const { branding, setBranding, isLoading, isSaving, saveBranding } = useBranding(
    storeId,
    toastMessages
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!branding) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{tMessages('notFound')}</p>
        <Link href="/stores" className="text-primary hover:underline mt-2 inline-block">
          {tActions('backToStores')}
        </Link>
      </div>
    );
  }

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle', { name: branding.name })}
      actions={
        <button
          type="button"
          onClick={saveBranding}
          disabled={isSaving}
          className="px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
        >
          {isSaving ? tActions('saving') : tActions('save')}
        </button>
      }
    >
      <div className="space-y-6">
        <BrandingTabs activeTab={activeTab} onTabChange={setActiveTab} />

        {activeTab === 'branding' && (
          <BrandingIdentityTab branding={branding} onChange={setBranding} storeId={storeId} />
        )}

        {activeTab === 'theme' && <ThemeTab branding={branding} onChange={setBranding} />}

        {activeTab === 'contact' && <ContactInfoTab branding={branding} onChange={setBranding} />}

        {activeTab === 'social' && <SocialLinksTab branding={branding} onChange={setBranding} />}
      </div>
    </AdminLayout>
  );
}
