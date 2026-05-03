-- SEO meta on categories. Mirrors the columns Store + Product
-- already have. Lets the AI bulk sweep target categories too,
-- and lets merchants edit category SEO from the category form.

ALTER TABLE "categories"
  ADD COLUMN "meta_title" TEXT,
  ADD COLUMN "meta_title_ar" TEXT,
  ADD COLUMN "meta_description" TEXT,
  ADD COLUMN "meta_description_ar" TEXT;
