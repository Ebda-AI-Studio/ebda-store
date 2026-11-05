'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { AdminSkeletonDetail } from '../../../../components/AdminSkeleton';
import { BrandingIdentityTab } from './_components/BrandingIdentityTab';
import { BrandingTabs } from './_components/BrandingTabs';
import { ContactInfoTab } from './_components/ContactInfoTab';
import { SocialLinksTab } from './_components/SocialLinksTab';
import { ThemeTab } from './_components/ThemeTab';
import { LocationsTab } from './_components/LocationsTab';
import type { BrandingTabId } from './_components/types';
import { useBranding } from './_hooks/useBranding';

/** The tabs `?tab=` may select (kept in step with BrandingTabId by the type below). */
const BRANDING_TAB_IDS = [
  'branding',
  'theme',
  'contact',
  'social',
  'locations',
] as const satisfies readonly BrandingTabId[];

export default function StoreBrandingPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const tPage = useT('branding.page');
  const tActions = useT('branding.actions');
  const tMessages = useT('branding.messages');
  const tTabs = useT('branding.tabs');

  const [activeTab, setActiveTab] = useState<BrandingTabId>('branding');

  // Admin search deep link (?tab=theme&setting=branding.logo-size): open the tab that holds the
  // control. Re-runs when another result on this same page changes the tab.
  const tabParam = useSearchParams().get('tab');
  useEffect(() => {
    if (tabParam && (BRANDING_TAB_IDS as readonly string[]).includes(tabParam)) {
      setActiveTab(tabParam as BrandingTabId);
    }
  }, [tabParam]);

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

  const { branding, setBranding, isLoading, isSaving, saveBranding, dirty, resetBranding } =
    useBranding(storeId, toastMessages);

  // Loading + not-found render INSIDE <AdminLayout> so the sidebar, hub tabs
  // and topbar stay mounted — an early return before the layout made the
  // whole admin chrome vanish and reappear (audit 2026-09-30 §8, fixed as a
  // class across every admin page).
  if (isLoading || !branding) {
    return (
      <AdminLayout title={tPage('title')}>
        {isLoading ? (
          <AdminSkeletonDetail showHeader={false} />
        ) : (
          <div className="text-center py-12">
            <p className="text-muted-foreground">{tMessages('notFound')}</p>
            <Link
              href="/stores"
              className="mt-2 inline-flex min-h-11 items-center text-primary-ink hover:underline"
            >
              {tActions('backToStores')}
            </Link>
          </div>
        )}
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle', { name: branding.name })}>
      <div className="space-y-6">
        <BrandingTabs activeTab={activeTab} onTabChange={setActiveTab} />

        {activeTab === 'branding' && (
          <BrandingIdentityTab branding={branding} onChange={setBranding} storeId={storeId} />
        )}

        {activeTab === 'theme' && (
          <ThemeTab branding={branding} onChange={setBranding} storeId={storeId} />
        )}

        {activeTab === 'contact' && <ContactInfoTab branding={branding} onChange={setBranding} />}

        {activeTab === 'social' && <SocialLinksTab branding={branding} onChange={setBranding} />}

        {activeTab === 'locations' && (
          <LocationsTab storeId={storeId} branding={branding} onChange={setBranding} />
        )}
      </div>
      <StickySaveBar
        dirty={dirty || isSaving}
        onSave={saveBranding}
        onReset={resetBranding}
        saving={isSaving}
        saveLabel={tActions('save')}
      />
    </AdminLayout>
  );
}
