/**
 * Per-customer coupon limit (`usageLimitPerUser`), enforced for REGISTERED customers by id and for GUESTS by a stable
 * contact key: the E.164 phone (`normalizePhoneForStorage`, the same normaliser the order stores and the buyer key
 * uses) and/or the lowercased email.
 *
 * Two defects this closes (money, 2026-10-25):
 *  1. A guest with neither a phone nor an email used to skip the check entirely ("a false block on an unidentifiable
 *     guest is worse than the loophole"), so a one-per-customer coupon was unlimited for anyone who left both fields
 *     out. Now such a guest is REFUSED the coupon with COUPON_NEEDS_CONTACT.
 *  2. The count was read without a lock, so N concurrent checkouts by one guest all read "0 used" and all redeemed.
 *     Now a transaction-scoped advisory lock per identity key (the stock-hold-cap pattern) serialises them: the count
 *     runs after the lock, and the redemption insert happens in the SAME transaction.
 * Cancelled and refunded orders do not count (their usageCount is given back).
 */
import { normalizePhoneForStorage } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

export interface CouponLimitTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface CouponLimitIdentity {
  customerId?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Spellings an Egyptian number may be stored under (legacy rows pre-date normalisation). */
export function phoneVariants(phone: string | null): string[] {
  if (!phone) return [];
  const e164 = normalizePhoneForStorage(phone);
  if (!e164) return [];
  const digits = e164.replace(/^\+/, '');
  const out = new Set<string>([e164, digits]);
  if (digits.startsWith('20') && digits.length === 12) out.add(`0${digits.slice(2)}`);
  return [...out];
}

export function normalizeCouponIdentity(i: CouponLimitIdentity): {
  customerId: string | null;
  email: string | null;
  phone: string | null;
} {
  const email = i.email?.trim().toLowerCase() || null;
  const phone = i.phone ? normalizePhoneForStorage(i.phone) || null : null;
  return { customerId: i.customerId || null, email, phone };
}

/**
 * How many LIVE orders this identity already placed with this coupon code. Takes the advisory locks first, so call it
 * inside the order transaction, before the redemption is claimed, and keep the transaction open until the order insert.
 * Throws COUPON_NEEDS_CONTACT for an unidentifiable guest.
 */
export async function countPriorCouponUses(
  tx: CouponLimitTx,
  storeId: string,
  couponCode: string,
  identity: CouponLimitIdentity
): Promise<number> {
  const id = normalizeCouponIdentity(identity);
  if (!id.customerId && !id.email && !id.phone) {
    throw new AppError(
      400,
      'COUPON_NEEDS_CONTACT',
      'This coupon is limited per customer: add a phone number or email to use it. / هذا الكوبون لكل عميل مرة واحدة، أضف رقم الموبايل أو الإيميل لاستخدامه.'
    );
  }
  const keys = [
    id.customerId
      ? JSON.stringify(['coupon-use', storeId, couponCode, 'customer', id.customerId])
      : null,
    id.phone ? JSON.stringify(['coupon-use', storeId, couponCode, 'phone', id.phone]) : null,
    id.email ? JSON.stringify(['coupon-use', storeId, couponCode, 'email', id.email]) : null,
  ]
    .filter((k): k is string => k !== null)
    .sort();
  for (const key of keys)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

  const variants = id.customerId ? [] : phoneVariants(id.phone);
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM "orders"
    WHERE "store_id" = ${storeId}
      AND "coupon_code" = ${couponCode}
      AND "status" NOT IN ('cancelled', 'refunded')
      AND "deleted_at" IS NULL
      AND (
        (${id.customerId}::text IS NOT NULL AND "customer_id" = ${id.customerId})
        OR (${id.customerId}::text IS NULL AND ${id.email}::text IS NOT NULL
            AND lower(btrim("shipping_address" #>> '{email}')) = ${id.email})
        OR (${id.customerId}::text IS NULL AND cardinality(${variants}::text[]) > 0
            AND "shipping_address" #>> '{phone}' = ANY(${variants}::text[]))
      )
  `;
  return Number(rows[0]?.n ?? 0);
}
