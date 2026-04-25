'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { CouponFormModal } from './_components/CouponFormModal';
import { CouponsFilters } from './_components/CouponsFilters';
import { CouponsTable } from './_components/CouponsTable';
import type { Coupon, CouponFormData } from './_components/types';
import { INITIAL_FORM_DATA } from './_components/types';
import { useCoupons } from './_hooks/useCoupons';

export default function CouponsPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const tPage = useT('coupons.page');
  const tActions = useT('coupons.actions');

  const {
    coupons,
    isLoading,
    searchTerm,
    setSearchTerm,
    filterActive,
    setFilterActive,
    fetchCoupons,
    saveCoupon,
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
      value: coupon.value,
      minOrderAmount: coupon.minOrderAmount ? String(coupon.minOrderAmount / 1000) : '',
      maxDiscount: coupon.maxDiscount ? String(coupon.maxDiscount / 1000) : '',
      usageLimit: coupon.usageLimit ? String(coupon.usageLimit) : '',
      usageLimitPerUser: coupon.usageLimitPerUser ? String(coupon.usageLimitPerUser) : '',
      isActive: coupon.isActive,
      startsAt: coupon.startsAt ? coupon.startsAt.slice(0, 16) : '',
      expiresAt: coupon.expiresAt ? coupon.expiresAt.slice(0, 16) : '',
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

  // Refetch whenever the status filter changes. Search is submitted on Enter.
  function handleFilterActiveChange(value: typeof filterActive) {
    setFilterActive(value);
    // Allow state to settle before refetching so the new value is included.
    setTimeout(() => {
      void fetchCoupons();
    }, 0);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <button
          type="button"
          onClick={openCreateModal}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 font-medium flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {tActions('create')}
        </button>
      }
    >
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
            onClose={closeModal}
          />
        )}
      </div>
    </AdminLayout>
  );
}
