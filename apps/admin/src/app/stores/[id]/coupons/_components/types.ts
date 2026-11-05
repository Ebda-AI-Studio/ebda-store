export type CouponType = 'percentage' | 'fixed' | 'free_shipping';

export interface Coupon {
  id: string;
  code: string;
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  type: CouponType;
  value: number;
  minOrderAmount?: number;
  maxDiscount?: number;
  usageLimit?: number;
  usageCount: number;
  usageLimitPerUser?: number;
  isActive: boolean;
  startsAt?: string;
  expiresAt?: string;
  createdAt: string;
  // Targeting — shared shape with Promotion (see promotion.routes.ts's
  // createSchema). All empty/null = "everyone, whole cart".
  customerGroupId?: string | null;
  firstOrderOnly?: boolean;
  minQuantity?: number | null;
  scopeProductIds?: string[];
  scopeCategoryIds?: string[];
}

export interface CouponFormData {
  code: string;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  type: CouponType;
  /** The value as typed (percent, or EGP for fixed). Text, so an unreadable entry is never turned into 0. */
  value: string;
  minOrderAmount: string;
  maxDiscount: string;
  usageLimit: string;
  usageLimitPerUser: string;
  isActive: boolean;
  startsAt: string;
  expiresAt: string;
  customerGroupId: string;
  firstOrderOnly: boolean;
  minQuantity: string;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
}

export type CouponStatusFilter = 'all' | 'active' | 'inactive';

export const INITIAL_FORM_DATA: CouponFormData = {
  code: '',
  name: '',
  nameAr: '',
  description: '',
  descriptionAr: '',
  type: 'percentage',
  value: '',
  minOrderAmount: '',
  maxDiscount: '',
  usageLimit: '',
  usageLimitPerUser: '',
  isActive: true,
  startsAt: '',
  expiresAt: '',
  customerGroupId: '',
  firstOrderOnly: false,
  minQuantity: '',
  scopeProductIds: [],
  scopeCategoryIds: [],
};
