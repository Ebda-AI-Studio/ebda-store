-- Custom-domain squatting (SP5 task 4, closing the SP4 tenancy review gap).
--
-- A store's custom domain used to be served the moment it was saved, so anyone
-- could claim `victim.com` and have the storefront (and the credentialed-CORS
-- allowlist) answer for it. Now `stores.domain` holds only a VERIFIED domain; an
-- unverified claim sits in `pending_domain` until the provider (Cloudflare for
-- SaaS custom hostname) reports it verified, and is released after 72h.
--
--   domain_status      pending | active | failed  (latest claim; NULL = no domain)
--   pending_domain     the claimed-but-unverified hostname (never served)
--   domain_claimed_at  when the pending claim was made (the 72h clock)
--   domain_verified_at when it became active
--
-- Backfill: every existing `domain` was already being served, so it becomes
-- `active` (no behaviour change for a live store).

ALTER TABLE "stores"
  ADD COLUMN "domain_status" TEXT,
  ADD COLUMN "pending_domain" TEXT,
  ADD COLUMN "domain_claimed_at" TIMESTAMP(3),
  ADD COLUMN "domain_verified_at" TIMESTAMP(3);

UPDATE "stores"
   SET "domain_status" = 'active',
       "domain_verified_at" = COALESCE("updated_at", NOW())
 WHERE "domain" IS NOT NULL;

ALTER TABLE "stores"
  ADD CONSTRAINT "stores_domain_status_check"
  CHECK ("domain_status" IS NULL OR "domain_status" IN ('pending', 'active', 'failed'));

CREATE INDEX "stores_pending_domain_idx" ON "stores" ("pending_domain");
