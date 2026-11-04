-- BE:F-5 / QA P2-5: provisioning created the default category ("Products") with no Arabic name, so an Arabic-default
-- storefront showed the English label. New stores get nameAr/descriptionAr at provisioning; this backfills the stores that
-- already exist on Postgres. Only the untouched default row is changed (slug 'products', name 'Products', no Arabic name yet):
-- a merchant who renamed it, or already set an Arabic name, keeps theirs. Idempotent. Stores on their Durable Object are
-- backfilled by the one-shot in docs/cf/default-category-backfill.md (their categories do not live in this table).
UPDATE "categories"
SET "name_ar" = 'المنتجات',
    "description_ar" = COALESCE("description_ar", 'كل المنتجات')
WHERE "slug" = 'products'
  AND "name" = 'Products'
  AND "name_ar" IS NULL
  AND "deleted_at" IS NULL;
