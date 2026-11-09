import { LOCKED_PUBLIC_PLANS, upgradePlanFor } from '@ebda/shared';

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

type PlanLocale = 'ar' | 'en';

/** "Growth and Business" / "النمو والأعمال": sold plans named in a sentence without typing them into a message. */
export function planNamesJoined(codes: readonly string[], locale: PlanLocale): string {
  const names = codes.map(c => planLabel(c, locale));
  if (names.length < 2) return names[0] ?? '';
  const last = names[names.length - 1]!;
  const head = names.slice(0, -1).join(locale === 'ar' ? '، ' : ', ');
  return locale === 'ar' ? `${head} و${last}` : `${head} and ${last}`;
}

/** The plan that sells wholesale pricing (a plan LIMIT, so the feature registry cannot name it). */
export function wholesalePlanName(locale: PlanLocale): string {
  const hit = upgradePlanFor('wholesalePricing', true);
  return hit ? (locale === 'ar' ? hit.nameAr : hit.nameEn) : planLabel('business', locale);
}

/** Every plan with a 14-day trial starts on this one. */
export const TRIAL_PLAN_CODE = 'growth';
