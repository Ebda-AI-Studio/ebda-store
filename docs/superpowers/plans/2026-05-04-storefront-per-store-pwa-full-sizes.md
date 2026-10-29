# Storefront per-store PWA — extend to full size set

**Date:** 2026-05-04
**Scope:** Ebda Store storefront only. Admin already updated to FSA branding + full sizes (separate work).

## Context

Per-store PWA is **already implemented** end-to-end. No new architecture needed — only filling in missing icon sizes.

**Existing pieces (don't rebuild):**

- `apps/web/src/app/manifest.ts` — dynamic manifest reads `getStore()` from host, fetches per-store config from API, falls back to generic store branding
- `apps/api/src/services/pwa.service.ts::generateManifest` — assembles per-store manifest from `Store.pwaSettings` JSONB
- `apps/api/src/routes/pwa.routes.ts` — exposes `GET /public/:storeId/manifest.json`
- `apps/admin/src/app/stores/[id]/pwa/` — admin settings page with `PwaIconUploader`, `PwaBranding`, etc.
- `Store.pwaEnabled`, `Store.pwaSettings` schema fields with `icon192`, `icon512`, `maskableIcon`, `themeColor`, `backgroundColor`, `appName`, `shortName`, etc.
- `pwa` feature flag in the Ebda Store feature toggle engine

**Gap:** existing implementation only supports `icon192` + `icon512` + `maskableIcon`. Missing the standard set: 384 (Android splash), 180 (iOS apple-touch), 32 + 16 (browser tab favicon). Merchants today get a degraded install experience on iOS (no apple-touch-icon → ugly default home-screen tile) and Android splash screens use the wrong size.

## Goal

Merchant uploads **one** high-res square logo (512×512+ PNG or SVG). Backend auto-generates the full size set via sharp, stores in R2 at `stores/{storeId}/pwa/`, manifest emits all six sizes.

## Implementation

### Task 1 — Schema additions

`packages/database/prisma/schema.prisma`: extend `Store.pwaSettings` JSONB shape (no migration needed since it's JSONB) with new optional fields:

- `iconSource` (URL of merchant-uploaded source image — the 512×512+ original)
- `icon384` (URL — generated)
- `iconAppleTouch` (URL — generated, 180×180)
- `favicon32` (URL — generated)
- `favicon16` (URL — generated)

The existing `icon192` / `icon512` / `maskableIcon` keep working — they're populated by the same generator pipeline.

Update `apps/api/src/services/pwa.service.ts` `PWASettings` interface to match.
Update `apps/admin/src/app/stores/[id]/pwa/_components/types.ts` to match.

### Task 2 — API: auto-generate icon set on upload

New helper in `apps/api/src/services/pwa.service.ts`:

```ts
import sharp from 'sharp';
import { uploadToR2 } from './storage.service';

interface GeneratedIcons {
  iconSource: string;
  icon192: string;
  icon384: string;
  icon512: string;
  iconAppleTouch: string;
  favicon32: string;
  favicon16: string;
  maskableIcon: string;
}

const TARGETS = [
  { key: 'icon192', size: 192, padded: false },
  { key: 'icon384', size: 384, padded: false },
  { key: 'icon512', size: 512, padded: false },
  { key: 'iconAppleTouch', size: 180, padded: false },
  { key: 'favicon32', size: 32, padded: false },
  { key: 'favicon16', size: 16, padded: false },
  // Maskable: source resized to ~80% inside a transparent square so iOS/Android safe-zone is respected
  { key: 'maskableIcon', size: 512, padded: true },
] as const;

export async function generatePwaIconSet(
  storeId: string,
  sourceBuffer: Buffer,
  background: { r: number; g: number; b: number; alpha: number } = { r: 0, g: 0, b: 0, alpha: 0 }
): Promise<GeneratedIcons> {
  const baseKey = `stores/${storeId}/pwa`;
  const results: Partial<GeneratedIcons> = {};

  // Upload source as-is (lets the merchant re-generate sizes later if the
  // pipeline changes, without re-asking them to upload).
  const sourceR2Key = `${baseKey}/source.png`;
  const sourcePng = await sharp(sourceBuffer).png({ compressionLevel: 9 }).toBuffer();
  results.iconSource = await uploadToR2(sourceR2Key, sourcePng, 'image/png');

  for (const t of TARGETS) {
    const innerSize = t.padded ? Math.floor(t.size * 0.8) : t.size;
    const buf = await sharp(sourceBuffer, { density: Math.max(384, t.size * 2) })
      .resize(innerSize, innerSize, { fit: 'contain', background })
      .extend(
        t.padded
          ? {
              top: Math.floor((t.size - innerSize) / 2),
              bottom: Math.ceil((t.size - innerSize) / 2),
              left: Math.floor((t.size - innerSize) / 2),
              right: Math.ceil((t.size - innerSize) / 2),
              background,
            }
          : { top: 0, bottom: 0, left: 0, right: 0, background }
      )
      .png({ compressionLevel: 9 })
      .toBuffer();
    const key = `${baseKey}/${t.key}.png`;
    results[t.key as keyof GeneratedIcons] = await uploadToR2(key, buf, 'image/png');
  }

  return results as GeneratedIcons;
}
```

### Task 3 — API route for icon upload

New endpoint in `apps/api/src/routes/pwa.routes.ts`:

```ts
// POST /stores/:id/pwa/icons   (admin-auth, requireStoreAccess, requireFeature('pwa'))
// Body: multipart/form-data with `source` field (PNG/SVG, 512×512+)
// Effect: generates 7 sizes, uploads to R2, updates Store.pwaSettings with the URLs
router.post(
  '/stores/:id/pwa/icons',
  authenticate,
  requireStoreAccess,
  requireFeature('pwa'),
  multerSingleField('source'),
  async (req, res) => {
    const { id: storeId } = req.params;
    const file = req.file;
    if (!file) throw new AppError(400, 'NO_FILE', 'Upload a square icon (PNG or SVG, 512×512+)');
    // Validate min dimensions
    const meta = await sharp(file.buffer).metadata();
    if ((meta.width ?? 0) < 512 || (meta.height ?? 0) < 512) {
      throw new AppError(400, 'ICON_TOO_SMALL', 'Icon must be at least 512×512');
    }
    const generated = await PWAService.generatePwaIconSet(storeId, file.buffer);
    await PWAService.updateSettings(storeId, { settings: generated });
    res.json({ icons: generated });
  }
);
```

### Task 4 — Manifest output: emit all sizes

Update `apps/api/src/services/pwa.service.ts::generateManifest`:

```ts
const iconList: Array<{ src: string; sizes: string; type: string; purpose?: string }> = [];

const sizes: Array<[keyof PWASettings, string]> = [
  ['favicon16', '16x16'],
  ['favicon32', '32x32'],
  ['iconAppleTouch', '180x180'],
  ['icon192', '192x192'],
  ['icon384', '384x384'],
  ['icon512', '512x512'],
];
for (const [field, size] of sizes) {
  if (settings[field]) {
    iconList.push({
      src: settings[field] as string,
      sizes: size,
      type: 'image/png',
      purpose: 'any',
    });
  }
}
if (settings.maskableIcon) {
  iconList.push({
    src: settings.maskableIcon,
    sizes: '512x512',
    type: 'image/png',
    purpose: 'maskable',
  });
}
manifest.icons = iconList;
```

### Task 5 — Storefront fallback chain

Update `apps/web/src/app/manifest.ts` so when the API doesn't return a manifest (fallback path) but `store.favicon` exists, emit only 192/512 (current behavior). Keep the path simple — full sizes only happen when the merchant has uploaded a source via the admin.

Also update `apps/web/src/app/layout.tsx` to wire `<link rel="apple-touch-icon">` and 16/32 favicons dynamically using `store.id` if exposed via metadata, OR rely entirely on the manifest (most browsers handle apple-touch-icon from the manifest now).

### Task 6 — Admin UI: single uploader replaces three URL fields

Update `apps/admin/src/app/stores/[id]/pwa/_components/PwaIconUploader.tsx`:

- Replace the three URL input fields (`icon192`, `icon512`, `maskableIcon`) with **one** drag-drop file uploader: "Upload your store icon (square PNG or SVG, 512×512+)"
- On upload, POST to `/stores/:id/pwa/icons`, show preview at 192/180/32 sizes (preview the rendered output)
- Keep the URL inputs as an "Advanced" disclosure for power users who want to override individual sizes
- Add bilingual labels per existing i18n pattern (next-intl)

Update `apps/admin/src/app/stores/[id]/pwa/_components/PwaManifestPreview.tsx` to show the full set including the new sizes.

### Task 7 — Migrate existing 2 stores

Done as `scripts/backfill-store-pwa-icons.ts` (Ruling PWA-BACKFILL-1): walks every `pwaEnabled` store, source = `iconSource`, else `icon512`, else `icon192`, else the store logo (a store with none is skipped), resizes with `sharp`, persists the URLs. Dry run unless `--apply`; idempotent (skips a store with all 8 icon keys, re-checks before writing); resumable (`--after <storeId>`, `--limit <n>`). Run from the repo root with the prod `DATABASE_URL`, the R2 storage env and `STORAGE_PUBLIC_URL` exported:

```bash
npx tsx scripts/backfill-store-pwa-icons.ts                      # dry run
npx tsx scripts/backfill-store-pwa-icons.ts --apply --limit 25   # then repeat with the printed --after
```

## Verification

1. **Per-tenant install on Chrome desktop:** open `demo-boutique.com` in Chrome → "Install demo-boutique" → installed app uses demo-boutique's logo + theme color, not Force orange. Same for Wady Aljuz.
2. **iOS apple-touch-icon:** Safari → demo-boutique.com → Add to Home Screen → home-screen tile shows demo-boutique's icon at the right size, no default white border.
3. **Browser tab favicon:** desktop browser tab shows the merchant's 32×32 favicon, not Force defaults.
4. **Manifest preview in admin:** the PWA settings page shows all 6 sizes after a single upload.
5. **R2 inspection:** `force-uploads` bucket has `stores/{storeId}/pwa/source.png`, `icon192.png`, … through `favicon16.png` for any store with `pwaEnabled=true`.

## Out of scope

- Multilingual app names (`appNameAr`) — already in schema, separate UX work to detect locale at install time
- Splash-screen image generation (separate iOS-specific feature, more complex)
- Per-locale icons — defer until a merchant asks
- Animated icons / theme variants

## Reference

- Existing memory: `feedback-ebda-cms-and-tenant-control` (every customer-facing string and visual block must be tenant-overridable)
- Existing memory: per-store R2 path convention `stores/<storeId>/<asset>/...` (commit `8863938`)
- Sharp is already in the Ebda Store monorepo node_modules
