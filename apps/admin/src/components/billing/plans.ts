import { LOCKED_PUBLIC_PLANS } from '@force/shared';
import { isTrialPlanCode } from './types';
import type { PlanOption, PlanSelection } from './types';

/** Public catalog used before a store exists (after that, the API's own list wins). */
export const STATIC_PLANS: PlanOption[] = LOCKED_PUBLIC_PLANS.filter(p =>
  isTrialPlanCode(p.code)
).map(p => ({
  code: p.code,
  nameEn: p.nameEn,
  nameAr: p.nameAr,
  priceMonthlyMinor: p.priceMonthlyMinor,
  priceYearlyMinor: p.priceYearlyMinor,
}));

export const DEFAULT_SELECTION: PlanSelection = { planCode: 'growth', interval: 'monthly' };
