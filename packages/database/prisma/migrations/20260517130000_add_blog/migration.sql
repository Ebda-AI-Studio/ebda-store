-- Migration: 20260517130000_add_blog
-- Bucket E1 (2026-05-17): per-store blog module.
--   stores.blog_enabled  - opt-in toggle (default false; existing stores unaffected)
--   blog_posts           - bilingual posts with isPublished gate + publishedAt

-- ==========================================
-- stores.blog_enabled
-- ==========================================
ALTER TABLE "stores" ADD COLUMN "blog_enabled" BOOLEAN NOT NULL DEFAULT false;

-- ==========================================
-- blog_posts
-- ==========================================
CREATE TABLE "blog_posts" (
    "id"           TEXT NOT NULL,
    "store_id"     TEXT NOT NULL,
    "slug"         TEXT NOT NULL,
    "title"        TEXT NOT NULL,
    "title_ar"     TEXT,
    "excerpt"      TEXT,
    "excerpt_ar"   TEXT,
    "content"      TEXT NOT NULL,
    "content_ar"   TEXT,
    "cover_image"  TEXT,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blog_posts_store_id_slug_key" ON "blog_posts"("store_id", "slug");

CREATE INDEX "blog_posts_store_id_is_published_published_at_idx"
    ON "blog_posts"("store_id", "is_published", "published_at");

ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
