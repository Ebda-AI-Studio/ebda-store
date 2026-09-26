'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../../../../lib/api';
import { textFieldValue, numericFieldValue, dateFieldValue } from '../../../../../lib/form-text';
import type { Coupon, CouponFormData, CouponStatusFilter } from '../_components/types';

interface UseCouponsResult {
  coupons: Coupon[];
  isLoading: boolean;
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  filterActive: CouponStatusFilter;
  setFilterActive: (value: CouponStatusFilter) => void;
  fetchCoupons: () => Promise<void>;
  saveCoupon: (data: CouponFormData, editingId: string | null) => Promise<boolean>;
  deleteCoupon: (couponId: string) => Promise<void>;
  toggleActive: (couponId: string) => Promise<void>;
}

/** A merchant-typed KWD amount → integer fils, rounded once. */
function kwdStringToFils(v: string): number {
  return Math.round(parseFloat(v) * 1000);
}

/**
 * The coupon create/update body. On update an emptied optional field must
 * send null to actually clear it, the way customerGroupId / minQuantity
 * already do. Exported so the money conversions are testable without a DOM.
 */
export function buildCouponPayload(formData: CouponFormData, intent: 'create' | 'update') {
  return {
    code: formData.code,
    name: formData.name,
    nameAr: textFieldValue(formData.nameAr, intent),
    description: textFieldValue(formData.description, intent),
    descriptionAr: textFieldValue(formData.descriptionAr, intent),
    type: formData.type,
    // `fixed` coupons: the input is in KWD (dinar) → store as fils (×1000).
    // `percentage` coupons: the value is a percent (e.g. 5 = 5%), stored as-is.
    value: formData.type === 'fixed' ? Math.round(formData.value * 1000) : formData.value,
    // Clearing a limit/date must remove the restriction (null), not
    // silently no-op (undefined) — same convention as the text fields
    // above. A cleared minOrderAmount/expiresAt/usageLimit makes the
    // coupon MORE permissive (no minimum / never expires / unlimited
    // uses); see CouponService.getByCode + evaluateForCart.
    // KWD → fils with the fraction kept. The edit form hydrates these as
    // fils / 1000 (e.g. 5500 → "5.5"), so `parseInt` here silently lowered a
    // 5.500 KWD minimum to 5.000 on every unrelated save (#1569).
    minOrderAmount: numericFieldValue(formData.minOrderAmount, intent, kwdStringToFils),
    maxDiscount: numericFieldValue(formData.maxDiscount, intent, kwdStringToFils),
    usageLimit: numericFieldValue(formData.usageLimit, intent, v => parseInt(v)),
    usageLimitPerUser: numericFieldValue(formData.usageLimitPerUser, intent, v => parseInt(v)),
    isActive: formData.isActive,
    startsAt: dateFieldValue(formData.startsAt, intent),
    expiresAt: dateFieldValue(formData.expiresAt, intent),
    // Targeting — shared shape with Promotion (see
    // promotion.routes.ts's createSchema). Empty group/scope = "everyone,
    // whole cart".
    customerGroupId: formData.customerGroupId || null,
    firstOrderOnly: formData.firstOrderOnly,
    minQuantity: formData.minQuantity ? parseInt(formData.minQuantity, 10) : null,
    scopeProductIds: formData.scopeProductIds,
    scopeCategoryIds: formData.scopeCategoryIds,
  };
}

export function useCoupons(storeId: string): UseCouponsResult {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterActive, setFilterActive] = useState<CouponStatusFilter>('all');

  const fetchCoupons = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (searchTerm) query.append('search', searchTerm);
      if (filterActive !== 'all') {
        query.append('isActive', filterActive === 'active' ? 'true' : 'false');
      }

      const { data } = await apiGet<{ coupons: Coupon[] }>(
        `/api/v1/stores/${storeId}/coupons?${query}`
      );
      if (data) {
        setCoupons(data.coupons);
      }
    } catch (error) {
      console.error('Failed to fetch coupons:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, searchTerm, filterActive]);

  useEffect(() => {
    void fetchCoupons();
    // Only refetch when storeId changes — filters/search trigger refetch manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const saveCoupon = useCallback(
    async (formData: CouponFormData, editingId: string | null): Promise<boolean> => {
      try {
        const endpoint = editingId
          ? `/api/v1/stores/${storeId}/coupons/${editingId}`
          : `/api/v1/stores/${storeId}/coupons`;

        const body = buildCouponPayload(formData, editingId ? 'update' : 'create');

        const { error } = editingId ? await apiPut(endpoint, body) : await apiPost(endpoint, body);

        if (error) {
          console.error('Failed to save coupon:', error.message);
          return false;
        }

        await fetchCoupons();
        return true;
      } catch (error) {
        console.error('Failed to save coupon:', error);
        return false;
      }
    },
    [storeId, fetchCoupons]
  );

  const deleteCoupon = useCallback(
    async (couponId: string) => {
      try {
        const { error } = await apiDelete(`/api/v1/stores/${storeId}/coupons/${couponId}`);
        if (!error) {
          await fetchCoupons();
        }
      } catch (error) {
        console.error('Failed to delete coupon:', error);
      }
    },
    [storeId, fetchCoupons]
  );

  const toggleActive = useCallback(
    async (couponId: string) => {
      try {
        const { error } = await apiPatch(`/api/v1/stores/${storeId}/coupons/${couponId}/toggle`);
        if (!error) {
          await fetchCoupons();
        }
      } catch (error) {
        console.error('Failed to toggle coupon:', error);
      }
    },
    [storeId, fetchCoupons]
  );

  return {
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
  };
}
