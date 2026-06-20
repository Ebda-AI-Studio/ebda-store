-- Per-category homepage-strip visibility. Default true = no change for
-- existing categories (they all keep showing as cards on the homepage strip).
-- Hiding is opt-in per category; the collection page / nav / filters are
-- unaffected by this flag (storefront filters the homepage strip only).
ALTER TABLE "categories" ADD COLUMN "show_on_home_strip" BOOLEAN NOT NULL DEFAULT true;
