# Image variants (webp width ladder)

Ruling PERF-STORE-3. Storefront images were served at stored size (up to 2000 px) into ~180 px slots, and Cloudflare Image Transformations are not enabled on the ebda.app zone. So the API pre-generates a width ladder at upload time and the storefront loader picks the smallest rung that covers the requested width.

## Naming contract (derived, never stored)

```
stores/<storeId>/products/<uuid>-name.jpg            original, unchanged
stores/<storeId>/products/<uuid>-name.jpg.w720.webp  variant (widths 480 / 720 / 960 / 1280)
```

Helpers live in `packages/shared/src/media/image-variants.ts` (`variantKey`, `variantKeysFor`, `isVariantKey`, `isVariantEligibleKey`, ...), shared by API and web so they cannot drift. Only jpg/jpeg/png/webp originals get variants (svg, gif, avif, fonts, models do not). Every rung always exists: a source narrower than a rung is re-encoded at its own width (no enlargement), and EXIF orientation is baked in.

## Who writes, deletes, ignores

- Generate: `apps/api/src/services/image-variants.service.ts` (sharp, webp q78, fail-soft, `[]` on Workers/animated/errors).
- Write: `StorageService.upload()` (and `uploadMultiple`) after the original PutObject; failures are logged, never fail the upload. `skipVariants: true` opts out (PWA icons in `pwa.service.ts`, expense receipts).
- Delete: `StorageService.delete()` / `deleteMultiple()` remove the ladder best-effort. `deleteByPrefix(Verified)` covers variants because they share the prefix (store erasure). `r2-cleanup.service.ts` goes through `delete()`. One-shot `scripts/downscale-oversized-hero.mjs` and `rescale-hero-to-4-3.mjs` delete the rungs inline.
- Ignore: `StorageService.listByPrefix` (admin media library) filters variants out. `r2-orphan-sweep.ts` and `scripts/r2-orphan-audit.ts` never count a variant as an orphan and delete the ladder together with an orphaned original.
- Read: the web image loader (`apps/web`), with an `onError` fall back to the original.

## Backfill

`scripts/backfill-image-variants.ts` — dry run by default, never deletes, resumable.

```
tsx scripts/backfill-image-variants.ts --prefix stores/<id>/ --limit 20          # dry run
tsx scripts/backfill-image-variants.ts --apply --concurrency 4
tsx scripts/backfill-image-variants.ts --apply --start-after <last key printed>
```

Rollout order: API deploy (new uploads get variants) -> backfill with `--apply` -> web deploy (loader starts requesting variant URLs). Deploying web first would 404 every old image until the loader's fallback kicks in.

## Cache-Control

Variants and store-namespaced originals get `public, max-age=31536000, immutable`: keys embed a fresh UUID, so the bytes under a key never change. Uploads where the caller picks the filename (overwritable keys) keep the plain 1-year cache.

## Known gap

Presigned direct uploads (`StorageService.getUploadUrl`) bypass `upload()` and are not varianted. No caller exists today; the loader's fallback to the original covers any that appear. Variants of an original deleted outside `StorageService` are not reaped by the sweep (they are never orphans on their own).
