'use client';

import { GoldRateBanner } from './_components/GoldRateBanner';
import { useCallback, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, useToast } from '@ebda/ui';
import { resolveDefaultLanguage } from '@ebda/shared';
import { AdminLayout } from '../../../components/AdminLayout';
import { useAuth } from '../../../lib/auth';
import { apiDelete } from '../../../lib/api';
import { getStoreDisplayUrl, getStoreHref } from '../../../lib/store-url';
import { useT } from '@/i18n/useT';
import { useDashboardData } from './_hooks/useDashboardData';
// The setup guide (SetupGuideCard) replaces the old static OnboardingChecklist:
// every row derives from real store data and the merchant can hide it.
import { SetupGuideCard } from './_components/SetupGuideCard';
import { StatsGrid } from './_components/StatsGrid';
import { OrderAlertsPromptCard } from '../../../components/OrderAlertsPromptCard';
import { DashboardAccountingSummary } from './_components/DashboardAccountingSummary';
import { StoreDetailsCard } from './_components/StoreDetailsCard';
import { StoreOwnerCard } from './_components/StoreOwnerCard';
import { AcquisitionCard } from './_components/AcquisitionCard';
import { QuickActions } from './_components/QuickActions';
import { SettingsLink } from './_components/SettingsLink';
import { SuspendStoreModal } from './_components/SuspendStoreModal';
import { DangerZone } from './_components/DangerZone';
import { DeleteStoreModal } from './_components/DeleteStoreModal';
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
  const tDanger = useT('stores.dashboard.dangerZone');
  const { success: toastSuccess, error: toastError } = useToast();
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
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteConfirm = useCallback(async () => {
    if (!store) return;
    setIsDeleting(true);
    try {
      const { error: apiError } = await apiDelete(`/api/v1/stores/${store.id}`);
      if (apiError) {
        toastError(tDanger('deleteFailed'), apiError.message ?? '');
        setIsDeleting(false);
        return;
      }
      toastSuccess(
        tDanger('deletedToastTitle'),
        tDanger('deletedToastDescription', { name: store.name })
      );
      // Close the modal so the closing animation runs before we navigate;
      // the redirect itself unmounts the page so isDeleting state cleanup
      // is implicit.
      setShowDeleteModal(false);
      router.push('/stores');
    } catch (err) {
      toastError(tDanger('deleteFailed'), err instanceof Error ? err.message : '');
      setIsDeleting(false);
    }
  }, [store, tDanger, toastError, toastSuccess, router]);

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
        <div className="flex gap-2">
          {!isEditing && (
            <Button size="sm" onClick={() => setIsEditing(true)}>
              {t('editStore')}
            </Button>
          )}
        </div>
      }
    >
      <GoldRateBanner storeId={store.id} />

      <SetupGuideCard
        storeId={store.id}
        storeUrl={getStoreHref(store)}
        storeName={store.name}
        locale={resolveDefaultLanguage(
          (store.settings as { defaultLanguage?: string } | undefined)?.defaultLanguage
        )}
      />

      <OrderAlertsPromptCard storeId={store.id} />

      <StatsGrid storeId={store.id} />

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
        />
        <div className="space-y-6">
          <StoreOwnerCard owner={store.owner} />
          {isSuperAdmin && <AcquisitionCard acquisition={store.owner.acquisition} />}
        </div>
      </div>

      {/* Custom Domain panel lives at /stores/[id]/domain — removed from the
          dashboard 2026-05-14 to avoid duplicating the surface and to keep
          the dashboard focused on quick-glance store overview + actions. */}

      <QuickActions
        store={store}
        isSuperAdmin={isSuperAdmin}
        isChangingStatus={isChangingStatus}
        onRequestSuspend={() => setShowSuspendModal(true)}
        onActivate={() => handleStatusChange('active')}
      />

      <SettingsLink storeId={store.id} />

      {/* Danger zone: hard-delete the entire store. Super_admin only —
          store admins must NOT see this. Rendered last so it's clearly
          separated from the rest of the dashboard. */}
      {isSuperAdmin && (
        <DangerZone isDeleting={isDeleting} onRequestDelete={() => setShowDeleteModal(true)} />
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

      <DeleteStoreModal
        isOpen={showDeleteModal}
        storeName={store.name}
        isDeleting={isDeleting}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handleDeleteConfirm}
      />
    </AdminLayout>
  );
}
