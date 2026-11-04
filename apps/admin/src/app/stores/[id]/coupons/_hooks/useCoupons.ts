'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../../../../lib/api';
import { textFieldValue, numericFieldValue, dateFieldValue } from '../../../../../lib/form-text';
import type { Coupon, CouponFormData, CouponStatusFilter } from '../_components/types';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

import { roundToMinor } from '@ebda/shared';
import { parseCouponValue } from './coupon-value';
interface UseCouponsResult {
  coupons: Coupon[];
  isLoading: boolean;
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  filterActive: CouponStatusFilter;
  setFilterActive: (value: CouponStatusFilter) => void;
  fetchCoupons: () => Promise<void>;
  saveCoupon: (data: CouponFormData, editingId: string | null) => Promise<boolean>;
  /** The server's (already localized) reason the last save was refused; null once a save succeeds. */
  saveError: string | null;
  clearSaveError: () => void;
  deleteCoupon: (couponId: string) => Promise<void>;
  toggleActive: (couponId: string) => Promise<void>;
  /** The list could not be read. The page shows an error with a retry, never "no coupons" (UX:S-1). */
  loadFailed: boolean;
  /** The save threw or the server refused it with no readable reason; the modal shows a generic Arabic line. */
  saveFailed: boolean;
  /** Which row action failed last; the page turns it into a toast and clears it. */
  actionError: 'delete' | 'toggle' | null;
  clearActionError: () => void;
}

/** A merchant-typed EGP amount → integer piastres, rounded once. */
function majorStringToMinor(v: string): number {
  return roundToMinor(parseFloat(v));
}

/**
 * The coupon create/update body. On update an emptied optional field must
 * send null to actually clear it, the way customerGroupId / minQuantity
 * already do. Exported so the money conversions are testable without a DOM.
 */
function couponValueForPayload(formData: CouponFormData): number {
  if (formData.type === 'free_shipping') return 0;
  const n = parseCouponValue(formData.value);
  if (Number.isNaN(n)) return 0;
  return formData.type === 'fixed' ? roundToMinor(n) : n;
}

export function buildCouponPayload(formData: CouponFormData, intent: 'create' | 'update') {
  return {
    code: formData.code,
    name: formData.name,
    nameAr: textFieldValue(formData.nameAr, intent),
    description: textFieldValue(formData.description, intent),
    descriptionAr: textFieldValue(formData.descriptionAr, intent),
    type: formData.type,
    // `fixed` coupons: the input is in EGP → store as piastres (×100, via roundToMinor).
    // `percentage` coupons: the value is a percent (e.g. 5 = 5%), stored as-is.
    // free_shipping carries no value; an unreadable entry is sent as 0 so the API refuses it by name (never a silent save).
    value: couponValueForPayload(formData),
    // Clearing a limit/date must remove the restriction (null), not
    // silently no-op (undefined) — same convention as the text fields
    // above. A cleared minOrderAmount/expiresAt/usageLimit makes the
    // coupon MORE permissive (no minimum / never expires / unlimited
    // uses); see CouponService.getByCode + evaluateForCart.
    // EGP → piastres with the fraction kept. The edit form hydrates these as
    // fromMinor(piastres) (e.g. 5500 → "5.5"), so `parseInt` here silently lowered a
    // 5.500 EGP minimum to 5.000 on every unrelated save (#1569).
    minOrderAmount: numericFieldValue(formData.minOrderAmount, intent, majorStringToMinor),
    maxDiscount: numericFieldValue(formData.maxDiscount, intent, majorStringToMinor),
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
  // Search-as-you-type: the list refetches 150 ms after the last keystroke; Enter still fetches at once.
  const debouncedSearch = useDebouncedValue(searchTerm, 150);

  // Bumped after a save/delete/toggle: the fetch effect owns EVERY request, so the refetch reads
  // the CURRENT filter, not the one captured when the mutation started (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<'delete' | 'toggle' | null>(null);
  const beginRequest = useLatestRequest();
  const fetchCoupons = useCallback(async () => {
    const isLatest = beginRequest();
    try {
      const query = new URLSearchParams();
      if (searchTerm) query.append('search', searchTerm);
      if (filterActive !== 'all') {
        query.append('isActive', filterActive === 'active' ? 'true' : 'false');
      }

      const { data, error } = await apiGet<{ coupons: Coupon[] }>(
        `/api/v1/stores/${storeId}/coupons?${query}`
      );
      if (!isLatest()) return;
      if (error) {
        setLoadFailed(true);
      } else if (data) {
        setLoadFailed(false);
        setCoupons(data.coupons);
      }
    } catch (error) {
      console.error('Failed to fetch coupons:', error);
      if (isLatest()) setLoadFailed(true);
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, [storeId, searchTerm, filterActive, beginRequest]);

  // Refetch when the store or the status filter changes. The status filter
  // used to refetch from the page via `setTimeout(fetchCoupons)` — a closure
  // from the render BEFORE the change, so every request carried the PREVIOUS
  // status and the list lagged one selection behind. Search stays
  // live (debounced) and also on Enter (`fetchCoupons` from the current render); the latest request wins.
  useEffect(() => {
    void fetchCoupons();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, filterActive, refreshKey, debouncedSearch]);

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
          // QA-PRICE-ZERO-1: a refusal (e.g. a 0% coupon) used to leave the modal open with no word. Show the reason.
          setSaveError(error.message || null);
          setSaveFailed(!error.message);
          return false;
        }

        setSaveError(null);
        setSaveFailed(false);
        setRefreshKey(k => k + 1);
        return true;
      } catch (error) {
        console.error('Failed to save coupon:', error);
        setSaveFailed(true);
        return false;
      }
    },
    [storeId]
  );

  const deleteCoupon = useCallback(
    async (couponId: string) => {
      try {
        const { error } = await apiDelete(`/api/v1/stores/${storeId}/coupons/${couponId}`);
        if (error) setActionError('delete');
        else setRefreshKey(k => k + 1);
      } catch (error) {
        console.error('Failed to delete coupon:', error);
        setActionError('delete');
      }
    },
    [storeId]
  );

  const toggleActive = useCallback(
    async (couponId: string) => {
      try {
        const { error } = await apiPatch(`/api/v1/stores/${storeId}/coupons/${couponId}/toggle`);
        if (error) setActionError('toggle');
        else setRefreshKey(k => k + 1);
      } catch (error) {
        console.error('Failed to toggle coupon:', error);
        setActionError('toggle');
      }
    },
    [storeId]
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
    saveError,
    clearSaveError: () => {
      setSaveError(null);
      setSaveFailed(false);
    },
    deleteCoupon,
    toggleActive,
    loadFailed,
    saveFailed,
    actionError,
    clearActionError: () => setActionError(null),
  };
}
