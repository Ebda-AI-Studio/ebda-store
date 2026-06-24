-- Additive, nullable, no default backfill: null means "use DOMAIN_PROVIDER env default".
-- Per-store override that flips a store's frontend between Vercel and Cloudflare-for-SaaS.
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "domain_provider" TEXT;
