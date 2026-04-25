'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../../../../lib/api';
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

        const body = {
          code: formData.code,
          name: formData.name,
          nameAr: formData.nameAr || undefined,
          description: formData.description || undefined,
          descriptionAr: formData.descriptionAr || undefined,
          type: formData.type,
          value: formData.value,
          minOrderAmount: formData.minOrderAmount
            ? parseInt(formData.minOrderAmount) * 1000
            : undefined,
          maxDiscount: formData.maxDiscount ? parseInt(formData.maxDiscount) * 1000 : undefined,
          usageLimit: formData.usageLimit ? parseInt(formData.usageLimit) : undefined,
          usageLimitPerUser: formData.usageLimitPerUser
            ? parseInt(formData.usageLimitPerUser)
            : undefined,
          isActive: formData.isActive,
          startsAt: formData.startsAt ? new Date(formData.startsAt).toISOString() : undefined,
          expiresAt: formData.expiresAt ? new Date(formData.expiresAt).toISOString() : undefined,
        };

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
