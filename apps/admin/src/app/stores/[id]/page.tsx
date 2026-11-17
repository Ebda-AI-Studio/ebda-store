'use client';

import { GoldRateBanner } from './_components/GoldRateBanner';
import { useCallback, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { cn } from '@ebda/ui';
import { buttonVariants } from '@/components/ui/Button';
import Link from 'next/link';
import { resolveDefaultLanguage } from '@ebda/shared';
import { AdminLayout } from '../../../components/AdminLayout';
import { useAuth } from '../../../lib/auth';
import { getStoreDisplayUrl, getStoreHref } from '../../../lib/store-url';
import { useT } from '@/i18n/useT';
import { useDashboardData } from './_hooks/useDashboardData';
// The setup guide (SetupGuideCard) replaces the old static OnboardingChecklist:
// every row derives from real store data and the merchant can hide it.
import { SetupGuideCard } from './_components/SetupGuideCard';
import { StorePulseBlock, TopProductsCard } from './_components/StorePulse';
import { useStorePulse, usePulsePeriod } from './_hooks/useStorePulse';
import { NeedsAction } from './_components/NeedsAction';
import { NextStepSlot } from './_components/NextStepSlot';
import { OrderAlertsPromptCard } from '../../../components/OrderAlertsPromptCard';
import { DashboardAccountingSummary } from './_components/DashboardAccountingSummary';
import { StoreDetailsCard } from './_components/StoreDetailsCard';
import { StoreOwnerCard } from './_components/StoreOwnerCard';
import { AcquisitionCard } from './_components/AcquisitionCard';
import { AssistantModeCard } from './_components/AssistantModeCard';
import { QuickActions } from './_components/QuickActions';
import { SettingsLink } from './_components/SettingsLink';
import { SuspendStoreModal } from './_components/SuspendStoreModal';
import { DangerZone } from './_components/DangerZone';
import { useDeleteStore } from '../_components/useDeleteStore';
import { StoreLoadingSkeleton } from './_components/StoreLoadingSkeleton';
import { StoreErrorState } from './_components/StoreErrorState';
import type { StoreFormErrors } from './_components/types';

export default function StoreDetailPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const t = useT('stores.dashboard');
  const tErrors = useT('stores.dashboard.details.errors');
  const translateError = useCallback(
    (key: string) => tErrors(key as Parameters<typeof tErrors>[0]),
    [tErrors]
  );

  const {
    store,
    isLoading,
    storeError,
    isEditing,
    isSaving,
    isChangingStatus,
    editForm,
    formErrors,
    setIsLoading,
    setIsEditing,
    setEditForm,
    setFormErrors,
    fetchStore,
    handleSave,
    handleStatusChange,
    resetEditForm,
  } = useDashboardData(storeId);

  const [showSuspendModal, setShowSuspendModal] = useState(false);
  const [period, setPeriod] = usePulsePeriod();
  const { pulse, reload: reloadPulse } = useStorePulse(storeId, period);
  const { requestDelete, dialog: deleteDialog } = useDeleteStore(
    useCallback(() => router.push('/stores'), [router])
  );

  const clearFieldError = useCallback(
    (field: keyof StoreFormErrors) => {
      setFormErrors(prev => ({ ...prev, [field]: undefined }));
    },
    [setFormErrors]
  );

  if (isLoading) {
    return <StoreLoadingSkeleton />;
  }

  if (!store) {
    return (
      <StoreErrorState
        storeError={storeError}
        onRetry={() => {
          setIsLoading(true);
          fetchStore();
        }}
      />
    );
  }

  return (
    <AdminLayout
      title={store.name}
      subtitle={getStoreDisplayUrl(store)}
      actions={
        // One primary: the editor, the job a merchant opens this page for. "View store" is the TopBar's own button.
        <Link href={`/stores/${store.id}/builder`} className={cn(buttonVariants({ size: 'sm' }))}>
          {t('openEditor')}
        </Link>
      }
    >
      <NeedsAction storeId={store.id} />

      {/* UX:D-5: one next step at a time: setup guide, else the order-alerts prompt, else the stale gold rate. */}
      <NextStepSlot>
        <SetupGuideCard
          storeId={store.id}
          storeUrl={getStoreHref(store)}
          storeName={store.name}
          locale={resolveDefaultLanguage(
            (store.settings as { defaultLanguage?: string } | undefined)?.defaultLanguage
          )}
        />
        <OrderAlertsPromptCard storeId={store.id} />
        <GoldRateBanner storeId={store.id} />
      </NextStepSlot>

      <StorePulseBlock
        pulse={pulse}
        period={period}
        onPeriod={setPeriod}
        onRetry={reloadPulse}
        storeId={store.id}
        storeUrl={getStoreHref(store)}
      />

      {/* Top products + the jobs to start: side by side on desktop, stacked on a phone. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <TopProductsCard products={pulse.topProducts} storeId={store.id} onRetry={reloadPulse} />
        <QuickActions store={store} isSuperAdmin={isSuperAdmin} />
      </div>

      <div className="mt-8">
        <DashboardAccountingSummary storeId={storeId} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <StoreDetailsCard
          store={store}
          isEditing={isEditing}
          isSaving={isSaving}
          editForm={editForm}
          formErrors={formErrors}
          onChangeForm={setEditForm}
          onClearFieldError={clearFieldError}
          onSave={() => handleSave(translateError)}
          onCancel={() => {
            setIsEditing(false);
            resetEditForm();
          }}
          onActivate={() => setIsEditing(true)}
          onEdit={() => setIsEditing(true)}
        />
        <div className="space-y-6">
          <StoreOwnerCard owner={store.owner} />
          {isSuperAdmin && <AcquisitionCard acquisition={store.owner.acquisition} />}
          {isSuperAdmin && <AssistantModeCard storeId={store.id} />}
        </div>
      </div>

      {/* Custom Domain panel lives at /stores/[id]/domain — removed from the
          dashboard 2026-05-14 to avoid duplicating the surface and to keep
          the dashboard focused on quick-glance store overview + actions. */}

      <SettingsLink storeId={store.id} />

      {/* Danger zone: hard-delete the entire store. Super_admin only —
          store admins must NOT see this. Rendered last so it's clearly
          separated from the rest of the dashboard. */}
      {isSuperAdmin && (
        <DangerZone
          onRequestDelete={() =>
            requestDelete({ id: store.id, name: store.name, slug: store.slug })
          }
          status={store.status}
          isChangingStatus={isChangingStatus}
          onRequestSuspend={() => setShowSuspendModal(true)}
          onActivate={() => handleStatusChange('active')}
        />
      )}

      <SuspendStoreModal
        isOpen={showSuspendModal}
        storeName={store.name}
        isChangingStatus={isChangingStatus}
        onClose={() => setShowSuspendModal(false)}
        onConfirm={() => {
          setShowSuspendModal(false);
          handleStatusChange('suspended');
        }}
      />

      {isSuperAdmin && deleteDialog}
    </AdminLayout>
  );
}
