'use client';

import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { AdminSkeletonTable } from '../../../../components/AdminSkeleton';
import { apiGet } from '../../../../lib/api';
import { CouponFormModal } from './_components/CouponFormModal';
import { CouponsFilters } from './_components/CouponsFilters';
import { CouponsTable } from './_components/CouponsTable';
import type { Coupon, CouponFormData } from './_components/types';
import { INITIAL_FORM_DATA } from './_components/types';
import { useCoupons } from './_hooks/useCoupons';
import { dateTimeLocalValue } from '@/lib/form-text';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';

import { fromMinor } from '@ebda/shared';
interface CustomerGroupOption {
  id: string;
  name: string;
  nameAr: string | null;
}

export default function CouponsPage() {
  const { gate } = useRequireFeature('coupons');

  const params = useParams();
  const storeId = params?.id as string;

  const tPage = useT('coupons.page');
  const tActions = useT('coupons.actions');

  const [customerGroups, setCustomerGroups] = useState<CustomerGroupOption[]>([]);

  useEffect(() => {
    if (!storeId) return;
    apiGet<{ groups: CustomerGroupOption[] }>(`/api/v1/stores/${storeId}/customer-groups`).then(
      ({ data }) => setCustomerGroups(data?.groups ?? [])
    );
  }, [storeId]);

  const {
    coupons,
    isLoading,
    searchTerm,
    setSearchTerm,
    filterActive,
    setFilterActive,
    fetchCoupons,
    saveCoupon,
    saveError,
    clearSaveError,
    deleteCoupon,
    toggleActive,
  } = useCoupons(storeId);

  const [showModal, setShowModal] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<Coupon | null>(null);
  const [formData, setFormData] = useState<CouponFormData>(INITIAL_FORM_DATA);

  function resetForm() {
    setFormData(INITIAL_FORM_DATA);
    setEditingCoupon(null);
  }

  function openCreateModal() {
    resetForm();
    setShowModal(true);
  }

  function openEditModal(coupon: Coupon) {
    setEditingCoupon(coupon);
    setFormData({
      code: coupon.code,
      name: coupon.name,
      nameAr: coupon.nameAr || '',
      description: coupon.description || '',
      descriptionAr: coupon.descriptionAr || '',
      type: coupon.type,
      // `fixed` coupons are stored in piastres → show as EGP (÷1000) in the form.
      // `percentage` coupons store the raw percent, shown as-is.
      value: String(coupon.type === 'fixed' ? fromMinor(coupon.value) : coupon.value),
      minOrderAmount: coupon.minOrderAmount ? String(fromMinor(coupon.minOrderAmount)) : '',
      maxDiscount: coupon.maxDiscount ? String(fromMinor(coupon.maxDiscount)) : '',
      usageLimit: coupon.usageLimit ? String(coupon.usageLimit) : '',
      usageLimitPerUser: coupon.usageLimitPerUser ? String(coupon.usageLimitPerUser) : '',
      isActive: coupon.isActive,
      startsAt: dateTimeLocalValue(coupon.startsAt),
      expiresAt: dateTimeLocalValue(coupon.expiresAt),
      customerGroupId: coupon.customerGroupId ?? '',
      firstOrderOnly: coupon.firstOrderOnly ?? false,
      minQuantity: coupon.minQuantity != null ? String(coupon.minQuantity) : '',
      scopeProductIds: coupon.scopeProductIds ?? [],
      scopeCategoryIds: coupon.scopeCategoryIds ?? [],
    });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    resetForm();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const success = await saveCoupon(formData, editingCoupon?.id ?? null);
    if (success) {
      closeModal();
    }
  }

  // useCoupons refetches when the status filter changes. Search is submitted
  // on Enter.
  function handleFilterActiveChange(value: typeof filterActive) {
    setFilterActive(value);
  }

  // Gate first, then render the loading state INSIDE <AdminLayout>. An early
  // `return <spinner/>` before the layout unmounted the whole sidebar, hub
  // tabs and topbar for the length of the fetch and remounted them after it,
  // which read as the page navigating away and back (audit 2026-09-30 §8).
  if (gate) return gate;

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <button
          type="button"
          onClick={openCreateModal}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 font-medium flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {tActions('create')}
        </button>
      }
    >
      {isLoading ? (
        <AdminSkeletonTable rows={6} columns={6} />
      ) : (
        <div className="space-y-6">
          <CouponsFilters
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            filterActive={filterActive}
            onFilterActiveChange={handleFilterActiveChange}
            onSubmitSearch={fetchCoupons}
          />

          <CouponsTable
            coupons={coupons}
            onEdit={openEditModal}
            onDelete={deleteCoupon}
            onToggleActive={toggleActive}
            onCreateFirst={openCreateModal}
          />

          {showModal && (
            <CouponFormModal
              isEditing={editingCoupon !== null}
              formData={formData}
              onChange={setFormData}
              onSubmit={handleSubmit}
              saveError={saveError}
              onDismissError={clearSaveError}
              onClose={closeModal}
              storeId={storeId}
              customerGroups={customerGroups}
            />
          )}
        </div>
      )}
    </AdminLayout>
  );
}
