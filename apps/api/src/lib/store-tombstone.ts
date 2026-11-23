/**
 * A purged or hard-removed store keeps a TOMBSTONE row in the platform D1 `stores` table (Ruling NZ-D15B, review of #1109).
 * Billing_events (Ebda's own invoices), instapay_receipts, manual_payment_claims, billing_reminders, store_subscriptions,
 * trust_requests and ai_usage all reference `stores(id)` ON DELETE CASCADE, so DELETING the row would silently destroy Ebda's own
 * billing and payment-proof records. Instead the row stays with every personal / identifying column cleared and the slug and
 * domain released (so the name can be re-used); the rows that hold people or credentials are deleted explicitly.
 * A tombstone is recognised by its slug prefix (`~purged~<id>`): the `stores.status` CHECK has no `purged` value and a schema
 * migration for a marker is not worth it. The marker contains `~`, which no slug validator accepts (`validateStoreSlugFormat`,
 * the directory's SLUG_RE, the admin schema), so a merchant can NEVER register a slug that collides with or impersonates a
 * tombstone; a separate reserved-prefix list would add nothing (the reserved set lives in the vendored foundation and is exact-match).
 * ORDER matters: the row is first made unresolvable (soft-deleted, inactive) in a statement of its own, and only then renamed, so
 * the store stops resolving even if the rename fails.
 *
 * wa-plan: not-plan-state (the store_subscriptions UPDATE below clears only the card reference and the provider customer id; plan,
 * status and period are untouched, so the WhatsApp plan observer has nothing to be told).
 */
export const PURGED_SLUG_PREFIX = '~purged~';

export const isPurgedSlug = (slug: string | null | undefined): boolean =>
  typeof slug === 'string' && slug.startsWith(PURGED_SLUG_PREFIX);

export interface Statement {
  sql: string;
  params: unknown[];
}

/** Soft-delete first, then explicit deletes (people, credentials, redirects), the scrubs of kept tables, and the rename LAST. Idempotent. */
export function tombstoneStatements(storeId: string, now: number = Date.now()): Statement[] {
  const del = (table: string, col = 'store_id'): Statement => ({
    sql: `DELETE FROM "${table}" WHERE "${col}" = ?1`,
    params: [storeId],
  });
  // numbered parameters: only bind what the statement references (D1 and node:sqlite both refuse extra bindings)
  const set = (sql: string): Statement => ({
    sql,
    params: sql.includes('?2') ? [storeId, now] : [storeId],
  });
  return [
    // 1. unresolvable first, in its own statement: if anything below fails, the store already stops resolving
    set(
      `UPDATE "stores" SET "status" = 'inactive', "deleted_at" = COALESCE("deleted_at", ?2), "updated_at" = ?2 WHERE "id" = ?1`
    ),
    del('store_staff'),
    del('merchant_api_keys'),
    del('staff_invites'),
    del('SlugRedirect', 'storeId'),
    // KEPT platform records lose their personal identifiers (Law 151/2020: no purpose left once the store is purged); amounts, dates,
    // references, invoice numbers, plan and status stay (tax and accounting records). Same columns as `eraseStorePlatformData` and the
    // payments erasure port (services/billing/payments-erasure.ts), re-applied here so a row created or left behind cannot slip through;
    // tests/unit/store-tombstone.test.ts reads the erasure classification and fails when a personal column of a kept table survives.
    set(
      `UPDATE "store_subscriptions" SET "provider_customer_id" = NULL, "payment_method_last4" = NULL WHERE "store_id" = ?1`
    ),
    set(
      `UPDATE "instapay_receipts" SET "payer_name" = NULL, "payer_address" = NULL, "payer_mobile" = NULL, "payer_bank" = NULL, "receiver_name" = NULL, "receiver_handle" = NULL, "receiver_mobile" = NULL, "note" = NULL, "extracted" = NULL, "review_note" = NULL, "reviewed_by" = NULL, "personal_scrubbed_at" = COALESCE("personal_scrubbed_at", ?2) WHERE "store_id" = ?1`
    ),
    set(
      `UPDATE "manual_payment_claims" SET "payer_reference" = 'erased:' || "id", "proof_url" = NULL, "review_note" = NULL, "reviewed_by" = NULL WHERE "store_id" = ?1 AND "payer_reference" NOT LIKE 'erased:%'`
    ),
    // the request kind, status and dates stay; the requester and the free text the merchant wrote do not
    set(
      `UPDATE "trust_requests" SET "user_id" = NULL, "message" = NULL, "evidence_url" = NULL WHERE "store_id" = ?1`
    ),
    set(`UPDATE "store_features" SET "enabled_by" = NULL WHERE "store_id" = ?1`),
    // the audit trail keeps what happened and when; who did it is removed (classification: actor id nulled)
    set(`UPDATE "platform_audit_log" SET "actor_id" = NULL WHERE "store_id" = ?1`),
    set(
      `UPDATE "provider_activation_requests" SET "requested_by_id" = NULL, "decided_by_id" = NULL WHERE "store_id" = ?1`
    ),
    {
      sql: `UPDATE "stores" SET "name" = '[purged]', "name_ar" = NULL, "slug" = '${PURGED_SLUG_PREFIX}' || "id", "domain" = NULL, "domain_status" = NULL, "pending_domain" = NULL, "domain_claimed_at" = NULL, "domain_verified_at" = NULL, "domain_provider" = NULL, "email_domain_id" = NULL, "email_domain_status" = NULL, "email_domain_verified_at" = NULL, "logo" = NULL, "logo_ar" = NULL, "favicon" = NULL, "updated_at" = ?2 WHERE "id" = ?1`,
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
