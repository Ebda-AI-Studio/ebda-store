# Admin fix pass, T2 (API domain), 2026-11-04

- Loyalty on Durable Object stores (L-1, Ruling FP-2): manual awards, signup and review bonuses, the members list, stats, history, the
  store-wide transaction log and the storefront balance now read and write the DO ledger. Postgres-only rows are migrated once
  (`docs/cf/loyalty-do-migration.md`).
- Loyalty award `points` is a non-zero whole number within 100000 (BE:S-27).
- Newsletter broadcast needs the `email_campaigns` plan feature and the write limiter (BE:S-5); the broadcast read and the subscriber
  exports are bounded (BE:E-5).
- Catalogue import needs `bulk_operations` on every route (BE:S-6).
- Count-session lines read a variant only through this store's product (BE:S-7).
- A custom shipping fee on a phone order is owner-only and audited; `POST /orders/admin` no longer admits the platform super-admin;
  override records are hidden from the customer timeline (BE:S-23, S-33, S-26).
- Percentage coupons are whole percents 1-100 (BE:S-24). Coupons and promotions can only target this store's customer groups; warehouse
  stock variants must belong to the product (BE:S-25).
- Zod on the bulk low-stock threshold and the four admin return actions (BE:S-28).
- Server plan gates where the UI already gated (D7): wholesale list and reject, coupon validate, loyalty join and my-transactions
  (BE:S-29). Staff can browse the first 500 customers only and each read is audited (D9, BE:S-30).
- Area-rate lists and the category list are bounded (BE:E-5).
- AI SEO states which fields are English and which Arabic, checks the answer, retries once, else `422 AI_WRONG_LANGUAGE` (BE:F-4).
- Default category has an Arabic name (new stores, Postgres backfill migration; DO stores per `docs/cf/default-category-backfill.md`) (BE:F-5).
- Product create accepts `image` or `images[]`, category create accepts `images[]`, product create returns `categoryId` (BE:F-6).
- Storefront sign-up form cannot lose a field to a stale state copy and waits for hydration (QA P2-1).
