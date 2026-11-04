import { LOCKED_PUBLIC_PLANS } from '@ebda/shared';

/**
 * The one source of plan names for admin copy (UX:C-5, QA P2-9). Derived from the locked public plan catalogue
 * so a message uses a `{plan}` placeholder instead of a hard-coded "Business". The word is always "باقة".
 */
export const PLAN_LABELS_AR: Record<string, string> = Object.fromEntries(
  LOCKED_PUBLIC_PLANS.map(p => [p.code, p.nameAr])
);

export const PLAN_LABELS_EN: Record<string, string> = Object.fromEntries(
  LOCKED_PUBLIC_PLANS.map(p => [p.code, p.nameEn])
);

/** The plan name in the given language, or the raw code when the plan is not a sold one. */
export function planLabel(code: string, locale: 'ar' | 'en'): string {
  return (locale === 'ar' ? PLAN_LABELS_AR : PLAN_LABELS_EN)[code] ?? code;
}
