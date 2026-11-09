# Default category Arabic name: backfill for DO stores (BE:F-5 / QA P2-5)

New stores get `nameAr = 'المنتجات'` and `descriptionAr = 'كل المنتجات'` on the default category at provisioning
(`provisioning.service.ts`). Postgres stores are backfilled by the migration `20261108000400_default_category_arabic_name`.

A store on its Durable Object keeps its categories in the DO, so the migration cannot reach them. Backfill from a Worker context, per DO store,
through the writer (`storeWriter(storeId)`):

```ts
await w.category.updateMany({
  where: { storeId, slug: 'products', name: 'Products', nameAr: null, deletedAt: null },
  data: { nameAr: 'المنتجات', descriptionAr: 'كل المنتجات' },
});
```

Only the untouched default row matches (a merchant who renamed it, or set an Arabic name, is left alone); idempotent.

## Lazy repair (2026-11-09)

No script run is needed. `GET /stores/:storeId/categories` (the merchant list) calls `backfillDefaultCategoryNameAr` (`apps/api/src/lib/default-category-backfill.ts`), which runs the `updateMany` above only when the list contains the untouched default row, patches the response in place and clears `public:categories:<storeId>`. Once repaired the read writes nothing. The storefront list stays read-only; it shows the Arabic name after the merchant's first visit to the categories page.
