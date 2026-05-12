-- Migration: 20260512050000_add_faq_howto_tables
-- Three tables backing AEO/GEO content:
--   store_faqs       – bilingual Q&A pairs per store
--   store_howtos     – bilingual how-to guides with JSON steps per store
--   product_faqs     – per-product Q&A pairs for Product schema inline embedding

-- ==========================================
-- store_faqs
-- ==========================================
CREATE TABLE "store_faqs" (
    "id"             TEXT NOT NULL,
    "store_id"       TEXT NOT NULL,
    "question"       TEXT NOT NULL,
    "question_ar"    TEXT,
    "answer"         TEXT NOT NULL,
    "answer_ar"      TEXT,
    "ai_drafted"     BOOLEAN NOT NULL DEFAULT false,
    "manually_edited" BOOLEAN NOT NULL DEFAULT false,
    "order_index"    INTEGER NOT NULL DEFAULT 0,
    "is_active"      BOOLEAN NOT NULL DEFAULT true,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_faqs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "store_faqs_store_id_is_active_order_index_idx"
    ON "store_faqs"("store_id", "is_active", "order_index");

ALTER TABLE "store_faqs"
    ADD CONSTRAINT "store_faqs_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ==========================================
-- store_howtos
-- ==========================================
CREATE TABLE "store_howtos" (
    "id"              TEXT NOT NULL,
    "store_id"        TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "title_ar"        TEXT,
    "description"     TEXT NOT NULL,
    "description_ar"  TEXT,
    "steps"           JSONB NOT NULL,
    "steps_ar"        JSONB,
    "ai_drafted"      BOOLEAN NOT NULL DEFAULT false,
    "manually_edited" BOOLEAN NOT NULL DEFAULT false,
    "order_index"     INTEGER NOT NULL DEFAULT 0,
    "is_active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_howtos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "store_howtos_store_id_is_active_order_index_idx"
    ON "store_howtos"("store_id", "is_active", "order_index");

ALTER TABLE "store_howtos"
    ADD CONSTRAINT "store_howtos_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ==========================================
-- product_faqs
-- ==========================================
CREATE TABLE "product_faqs" (
    "id"              TEXT NOT NULL,
    "product_id"      TEXT NOT NULL,
    "question"        TEXT NOT NULL,
    "question_ar"     TEXT,
    "answer"          TEXT NOT NULL,
    "answer_ar"       TEXT,
    "ai_drafted"      BOOLEAN NOT NULL DEFAULT false,
    "manually_edited" BOOLEAN NOT NULL DEFAULT false,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_faqs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_faqs_product_id_idx"
    ON "product_faqs"("product_id");

ALTER TABLE "product_faqs"
    ADD CONSTRAINT "product_faqs_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
