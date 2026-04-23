export type CouponType = 'percentage' | 'fixed' | 'free_shipping';

export interface Coupon {
  id: string;
  code: string;
  name: string;
  nameAr?: string;
  description?: string;
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
}

export interface CouponFormData {
  code: string;
  name: string;
  nameAr: string;
  description: string;
  type: CouponType;
  value: number;
  minOrderAmount: string;
  maxDiscount: string;
  usageLimit: string;
  usageLimitPerUser: string;
  isActive: boolean;
  startsAt: string;
  expiresAt: string;
}

export type CouponStatusFilter = 'all' | 'active' | 'inactive';

export const INITIAL_FORM_DATA: CouponFormData = {
  code: '',
  name: '',
  nameAr: '',
  description: '',
  type: 'percentage',
  value: 0,
  minOrderAmount: '',
  maxDiscount: '',
  usageLimit: '',
  usageLimitPerUser: '',
  isActive: true,
  startsAt: '',
  expiresAt: '',
};
