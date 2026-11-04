'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@ebda/ui';
import type { FormEvent } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { PageState } from '../../../../components/PageState';
import { apiGet } from '../../../../lib/api';
import { CouponFormModal } from './_components/CouponFormModal';
import { CouponsFilters } from './_components/CouponsFilters';
import { CouponsTable } from './_components/CouponsTable';
import type { Coupon, CouponFormData } from './_components/types';
import { INITIAL_FORM_DATA } from './_components/types';
import { useCoupons } from './_hooks/useCoupons';
import { parseCouponValue } from './_hooks/coupon-value';
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
  const tModal = useT('coupons.modal');
  const toast = useToast();

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
    loadFailed,
    saveFailed,
    actionError,
    clearActionError,
  } = useCoupons(storeId);

  // Row actions (delete / toggle) report failure as a toast; the hook only records which one failed.
  useEffect(() => {
    if (!actionError) return;
    toast.error(tPage(actionError === 'delete' ? 'deleteFailed' : 'toggleFailed'));
    clearActionError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionError]);

  const [valueError, setValueError] = useState<string | null>(null);

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
    setValueError(null);
  }

  /** UX:S-2 - the discount value is checked before any request, with the field named. */
  function validateValue(data: CouponFormData): string | null {
    if (data.type === 'free_shipping') return null;
    const n = parseCouponValue(data.value);
    if (Number.isNaN(n) || n <= 0) return tModal('valueInvalid');
    if (data.type === 'percentage' && n > 100) return tModal('valuePercentMax');
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateValue(formData);
    setValueError(invalid);
    if (invalid) return;
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
          className="px-4 py-2 min-h-11 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 font-medium flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {tActions('create')}
        </button>
      }
    >
      <PageState
        loading={isLoading}
        error={loadFailed ? tPage('loadFailed') : null}
        onRetry={fetchCoupons}
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
              onChange={next => {
                setFormData(next);
                if (valueError) setValueError(null);
              }}
              onSubmit={handleSubmit}
              saveError={saveError}
              saveFailed={saveFailed}
              valueError={valueError}
              onDismissError={clearSaveError}
              onClose={closeModal}
              storeId={storeId}
              customerGroups={customerGroups}
            />
          )}
        </div>
      </PageState>
    </AdminLayout>
  );
}
