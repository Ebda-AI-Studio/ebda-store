'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@force/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { useAuth } from '../../../lib/auth';
import { useT } from '@/i18n/useT';
import { useDashboardData } from './_hooks/useDashboardData';
import { OnboardingChecklist } from './_components/OnboardingChecklist';
import { StatsGrid } from './_components/StatsGrid';
import { StoreDetailsCard } from './_components/StoreDetailsCard';
import { StoreOwnerCard } from './_components/StoreOwnerCard';
import { DomainSection } from './_components/DomainSection';
import { QuickActions } from './_components/QuickActions';
import { SettingsLink } from './_components/SettingsLink';
import { SuspendStoreModal } from './_components/SuspendStoreModal';
import { StoreLoadingSkeleton } from './_components/StoreLoadingSkeleton';
import { StoreErrorState } from './_components/StoreErrorState';
import type { StoreFormErrors } from './_components/types';

export default function StoreDetailPage() {
  const params = useParams();
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
      subtitle={store.domain || `force-web-sigma.vercel.app/${store.slug}`}
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
      <OnboardingChecklist store={store} onStoreActivated={fetchStore} />

      <StatsGrid store={store} />

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
        />
        <StoreOwnerCard owner={store.owner} />
      </div>

      <DomainSection storeId={store.id} domain={store.domain} onDomainChange={fetchStore} />

      <QuickActions
        store={store}
        isSuperAdmin={isSuperAdmin}
        isChangingStatus={isChangingStatus}
        onRequestSuspend={() => setShowSuspendModal(true)}
        onActivate={() => handleStatusChange('active')}
      />

      <SettingsLink storeId={store.id} />

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
    </AdminLayout>
  );
}
