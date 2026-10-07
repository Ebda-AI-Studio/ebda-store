-- Visual builder Phase 1: persisted page documents with draft / published / archived revisions.
--
--   store_page_revisions   NEW, store-scoped. One row per saved revision of a page's
--                          PageDefinition (packages/shared/src/builder). `rev` is monotonic per
--                          (store_id, page_key) and is the optimistic-concurrency token.
--
-- Additive only: no existing table changes. A page with no published row is rendered from
-- stores.layout_settings through the adapter exactly as before; publishing back-writes
-- stores.layout_settings, so every legacy reader keeps working.
-- Rollback: DROP TABLE store_page_revisions (nothing else references it) — docs/ROLLBACK.md.

CREATE TABLE "store_page_revisions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "page_key" TEXT NOT NULL,
    "rev" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "doc_bytes" INTEGER NOT NULL,
    "base_rev" INTEGER,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "store_page_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "store_page_revisions_status_check" CHECK ("status" IN ('draft', 'published', 'archived')),
    CONSTRAINT "store_page_revisions_rev_check" CHECK ("rev" >= 1),
    -- mirrors BUILDER_LIMITS.maxDocBytes (256 KB) as a last line behind the validator
    CONSTRAINT "store_page_revisions_doc_bytes_check" CHECK ("doc_bytes" >= 0 AND "doc_bytes" <= 262144),
    CONSTRAINT "store_page_revisions_page_key_check" CHECK ("page_key" ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

CREATE UNIQUE INDEX "store_page_revisions_store_id_page_key_rev_key" ON "store_page_revisions"("store_id", "page_key", "rev");
CREATE INDEX "store_page_revisions_store_id_page_key_created_at_idx" ON "store_page_revisions"("store_id", "page_key", "created_at" DESC);
-- At most ONE working draft and ONE published revision per page: a concurrent promote or a
-- second draft insert loses on these indexes (-> 409), never silently.
CREATE UNIQUE INDEX "store_page_revisions_one_published" ON "store_page_revisions"("store_id", "page_key") WHERE "status" = 'published';
CREATE UNIQUE INDEX "store_page_revisions_one_draft" ON "store_page_revisions"("store_id", "page_key") WHERE "status" = 'draft';

ALTER TABLE "store_page_revisions" ADD CONSTRAINT "store_page_revisions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict tenant isolation (R-EBDA-001): the same single policy every store_id table carries.
ALTER TABLE store_page_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_page_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON store_page_revisions AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
