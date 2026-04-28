-- Per-store editable Pages CMS.
--
-- Stores merchant-authored long-form content for About / Privacy / Terms /
-- Shipping / FAQ + custom pages, identified by a per-store unique slug.
-- Content is markdown (rendered through a hand-rolled renderer in the
-- storefront so we don't pull in a new dep). Storefront falls through to
-- the legacy hardcoded copy when a row is missing or unpublished, so
-- legacy stores don't lose their pages overnight while merchants migrate.

CREATE TABLE IF NOT EXISTS "store_pages" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT,
    "title_ar" TEXT,
    "content_md" TEXT,
    "content_md_ar" TEXT,
    "cover_image" TEXT,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_pages_pkey" PRIMARY KEY ("id")
);

-- Composite unique on (store_id, slug). Same slug ('about', 'privacy', ...)
-- can exist across stores; within a single store each slug is unique.
CREATE UNIQUE INDEX IF NOT EXISTS "store_pages_store_id_slug_key" ON "store_pages"("store_id", "slug");

CREATE INDEX IF NOT EXISTS "store_pages_store_id_idx" ON "store_pages"("store_id");

-- FK with cascade so deleting a tenant cleans up their CMS pages.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'store_pages_store_id_fkey'
    ) THEN
        ALTER TABLE "store_pages"
          ADD CONSTRAINT "store_pages_store_id_fkey"
          FOREIGN KEY ("store_id") REFERENCES "stores"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;
