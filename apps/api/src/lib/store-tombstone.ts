/**
 * A purged or hard-removed store keeps a TOMBSTONE row in the platform D1 `stores` table (Ruling NZ-D15B, review of #1109).
 * Billing_events (Ebda's own invoices), instapay_receipts, manual_payment_claims, billing_reminders, store_subscriptions,
 * trust_requests and ai_usage all reference `stores(id)` ON DELETE CASCADE, so DELETING the row would silently destroy Ebda's own
 * billing and payment-proof records. Instead the row stays with every personal / identifying column cleared and the slug and
 * domain released (so the name can be re-used); the rows that hold people or credentials are deleted explicitly.
 * A tombstone is recognised by its slug prefix (`purged-<id>`): the `stores.status` CHECK has no `purged` value and a schema
 * migration for a marker is not worth it. It is soft-deleted (`deleted_at` set) so it never resolves as a storefront.
 */
export const PURGED_SLUG_PREFIX = 'purged-';

export const isPurgedSlug = (slug: string | null | undefined): boolean =>
  typeof slug === 'string' && slug.startsWith(PURGED_SLUG_PREFIX);

export interface Statement {
  sql: string;
  params: unknown[];
}

/** Explicit deletes first (people, credentials, redirects), then the tombstone UPDATE. Idempotent. */
export function tombstoneStatements(storeId: string, now: number = Date.now()): Statement[] {
  const del = (table: string, col = 'store_id'): Statement => ({
    sql: `DELETE FROM "${table}" WHERE "${col}" = ?1`,
    params: [storeId],
  });
  return [
    del('store_staff'),
    del('merchant_api_keys'),
    del('staff_invites'),
    del('SlugRedirect', 'storeId'),
    {
      sql:
        `UPDATE "stores" SET "name" = '[purged]', "name_ar" = NULL, "slug" = '${PURGED_SLUG_PREFIX}' || "id", ` +
        `"domain" = NULL, "domain_status" = NULL, "pending_domain" = NULL, "domain_claimed_at" = NULL, ` +
        `"domain_verified_at" = NULL, "domain_provider" = NULL, "email_domain_id" = NULL, "email_domain_status" = NULL, ` +
        `"email_domain_verified_at" = NULL, "logo" = NULL, "logo_ar" = NULL, "favicon" = NULL, "status" = 'inactive', ` +
        `"deleted_at" = COALESCE("deleted_at", ?2), "updated_at" = ?2 WHERE "id" = ?1`,
      params: [storeId, now],
    },
  ];
}

/** Latest date over the platform records that must outlive the store (Ebda's invoices and payment proofs), epoch ms or null. */
export const PLATFORM_RECORDS_LAST_AT_SQL =
  `SELECT max(t) AS last FROM (` +
  `SELECT max("created_at") AS t FROM "billing_events" WHERE "store_id" = ?1 UNION ALL ` +
  `SELECT max("created_at") FROM "instapay_receipts" WHERE "store_id" = ?1 UNION ALL ` +
  `SELECT max("created_at") FROM "manual_payment_claims" WHERE "store_id" = ?1)`;
