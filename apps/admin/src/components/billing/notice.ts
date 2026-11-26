import { planLabel as soldPlanLabel } from '@/lib/plan-labels';
import { cardLabel, fmtDate, type UiLocale } from './format';
import type { BillingInfo } from './types';

export type BillingNoticeKind = 'unpaid' | 'overStoreLimit' | 'overdue' | 'graceEnding' | 'dueSoon';

/** Which billing notice (if any) the merchant must see, most severe first. */
export function billingNotice(b: BillingInfo | null | undefined): BillingNoticeKind | null {
  if (!b) return null;
  if (b.suspension?.reason === 'unpaid') return 'unpaid';
  if (b.suspension?.reason === 'over_store_limit') return 'overStoreLimit';
  // Ruling BILL-NOTICE-1: the last day of grace gets its own, louder wording.
  if (b.overdue && b.suspendAt && new Date(b.suspendAt).getTime() - Date.now() <= 86_400_000) {
    return 'graceEnding';
  }
  if (b.overdue) return 'overdue';
  if (b.dueSoon && b.dueSoon.daysLeft <= 7) return 'dueSoon';
  return null;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Title (and optional detail) for a notice, in the active locale. `t` is `useT('billing.notice')`. */
export function noticeText(
  kind: BillingNoticeKind,
  b: BillingInfo,
  t: Translate,
  locale: UiLocale
): { title: string; body: string | null } {
  switch (kind) {
    case 'unpaid':
      return { title: t('unpaidTitle'), body: t('unpaidBody') };
    case 'overStoreLimit':
      return {
        title: t('overLimitTitle'),
        body: t('overLimitBody', { plan: soldPlanLabel('business', locale) }),
      };
    case 'overdue':
      return {
        title: t('overdueTitle'),
        body: b.suspendAt
          ? t('overdueBody', { date: fmtDate(b.suspendAt, locale) })
          : t('overdueBodyNoDate'),
      };
    case 'graceEnding':
      return {
        title: t('graceEndingTitle'),
        body: t('overdueBody', { date: fmtDate(b.suspendAt, locale) }),
      };
    case 'dueSoon': {
      const chargeAt = b.nextCharge?.at ?? b.dueSoon?.dueAt ?? null;
      if (b.hasPaymentMethod && b.billingMethod !== 'instapay' && b.card?.last4) {
        return {
          title: t('chargeSoon', { card: cardLabel(b.card), date: fmtDate(chargeAt, locale) }),
          body: null,
        };
      }
      return { title: t('dueSoonTitle', { n: b.dueSoon?.daysLeft ?? 0 }), body: null };
    }
  }
}

/**
 * STORE-QA-24: an active (or granted) plan far from its renewal is NOT "due". The InstaPay amount / receipt upload / "returns to
 * Free" warning belong only to a payment that is actually due: inside the renewal window (the same `dueSoon <= 7 days` rule
 * `billingNotice` uses), overdue, past due, suspended, or a plan the merchant has just picked to pay for now.
 */
export function isRenewalOnly(
  status: string | undefined,
  b: BillingInfo | null | undefined,
  hasFreshQuote: boolean
): boolean {
  if (status !== 'active' && status !== 'comped') return false;
  if (hasFreshQuote || !b) return false;
  return billingNotice(b) === null && !b.suspension;
}
