-- Ebda's own ads tracking (docs/ebda/ads-tracking.md). EXPAND ONLY: one nullable column,
-- nothing existing is altered or dropped, no default, no rewrite of the users table.
--
-- `users.acquisition` holds the first-touch attribution a merchant signed up with (utm_*,
-- fbclid, Meta fbc/fbp, PostHog id, the consent they gave and the signup request's ip/ua for
-- the server-side Conversions API). Written once by the signup route, only when the visitor
-- consented; NULL for every existing user, every customer and every super-admin. Shown to
-- super-admins on the store detail page; never returned to the merchant.
ALTER TABLE "users" ADD COLUMN "acquisition" JSONB;
