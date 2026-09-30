import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { featureService } from './feature.service';
import { StorageService } from './storage.service';
import { revalidateStorefront } from '../lib/revalidate-storefront';
import logger from '../lib/logger';

// PWA Settings structure
export interface PWASettings {
  // App Identity
  appName: string;
  appNameAr?: string;
  shortName: string;
  shortNameAr?: string;
  description: string;
  descriptionAr?: string;

  // Theme
  themeColor: string;
  backgroundColor: string;

  // Icons — full set added in B5 (docs/superpowers/plans/2026-05-04-
  // storefront-per-store-pwa-full-sizes.md). All optional/nullable-by-
  // absence; a store that only ever set icon192/icon512/maskableIcon keeps
  // working exactly as before (see generateManifest's backward-compat path).
  icon192?: string;
  icon512?: string;
  maskableIcon?: string;
  /** Merchant-uploaded 512x512+ source image the generated set is derived from. */
  iconSource?: string;
  /** 384x384 — Android splash/adaptive icon size. */
  icon384?: string;
  /** 180x180 — iOS apple-touch-icon. */
  iconAppleTouch?: string;
  /** 32x32 — browser-tab favicon. */
  favicon32?: string;
  /** 16x16 — browser-tab favicon (small). */
  favicon16?: string;

  // Display
  display: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser';
  orientation: 'any' | 'portrait' | 'landscape';
  startUrl: string;

  // Features
  installPromptEnabled: boolean;
  offlineEnabled: boolean;
  pushNotificationsEnabled: boolean;

  // iOS Specific
  iosStatusBarStyle: 'default' | 'black' | 'black-translucent';
  splashScreenColor: string;
}

/**
 * Result of generatePwaIconSet — every field is a public R2 URL.
 */
export interface GeneratedPwaIcons {
  iconSource: string;
  icon192: string;
  icon384: string;
  icon512: string;
  iconAppleTouch: string;
  favicon32: string;
  favicon16: string;
  maskableIcon: string;
}

/**
 * Icon sizes generated from a single merchant-uploaded source image.
 *
 * `padded: true` (maskable only) shrinks the source to ~80% inside a
 * transparent square so Android/iOS adaptive-icon safe zones don't clip the
 * artwork — the standard maskable-icon safe-zone convention.
 */
const ICON_TARGETS: ReadonlyArray<{
  key: Exclude<keyof GeneratedPwaIcons, 'iconSource'>;
  size: number;
  padded: boolean;
}> = [
  { key: 'icon192', size: 192, padded: false },
  { key: 'icon384', size: 384, padded: false },
  { key: 'icon512', size: 512, padded: false },
  { key: 'iconAppleTouch', size: 180, padded: false },
  { key: 'favicon32', size: 32, padded: false },
  { key: 'favicon16', size: 16, padded: false },
  { key: 'maskableIcon', size: 512, padded: true },
];

/**
 * Generate the full PWA icon size set from one merchant-uploaded source
 * image and upload every size to R2 under `stores/<storeId>/pwa/`.
 *
 * Deviation from the 2026-05-04 plan: the plan's sketch called a
 * `uploadToR2` helper that doesn't exist in this codebase. This reuses the
 * repo's actual upload primitive, `StorageService.upload` (same one every
 * other admin upload surface — logos, hero, fonts — goes through).
 *
 * Every icon key carries a per-generation VERSION suffix (`icon192-<ver>`),
 * unlike the fixed `filename: target.key` this replaced. `StorageService`
 * sets `CacheControl: public, max-age=31536000` (one year) on every upload,
 * so a fixed key meant re-uploading a new source kept the SAME R2 key and
 * URL — the browser/edge/PWA cache kept serving the OLD icon bytes for up to
 * a year, because nothing about the URL ever changed. Versioning the key
 * makes a new generation a NEW URL, which busts every cache layer for free.
 *
 * It also closes the partial-failure defect this loop otherwise has: because
 * every target now gets a key nothing has ever pointed at, a mid-loop throw
 * (network blip, R2 hiccup) can no longer overwrite an EARLIER target that
 * was already live and referenced by `Store.pwaSettings` — the previous
 * generation's icons stay exactly as they were, still serving, still
 * consistent with the DB, until this call fully succeeds and its caller
 * persists the new URLs. On success the route deletes the PREVIOUS
 * generation's objects once the write commits (`cleanupRemovedJsonUrls` in
 * pwa.routes.ts, issue 2201), so a regeneration does not accumulate ~9
 * objects per upload. A failed run leaves orphaned new-version objects in
 * R2, never a half-updated live set. Those orphans are cheap and are REPORTED
 * by the weekly `r2-orphan-sweep` and `scripts/r2-orphan-audit.ts` (deleted
 * only when an operator opts in: `R2_ORPHAN_SWEEP_APPLY=true` / `--apply`).
 * Both read `Store.pwaSettings` through the shared `R2_REFERENCE_COLUMNS`
 * registry (lib/r2-references.ts), so the LIVE generation's icons count as
 * referenced and are never swept; `tests/unit/r2-reference-registry.test.ts`
 * pins that.
 *
 * Two separate failure domains, handled in two phases (issues #1913/#1916):
 *
 *  1. Run the ENTIRE sharp pipeline first and hold every output buffer in
 *     memory before any upload starts. A corrupt/garbage source, an
 *     unsupported format, or a decode/OOM failure therefore never touches
 *     R2 at all — it 400s as `ICON_GENERATION_FAILED` with every existing
 *     icon object (the previous generation) untouched.
 *  2. Only once every buffer exists do uploads start, concurrently (see
 *     below). This phase can still fail (R2 outage, a dropped `pwa` folder
 *     allowlist entry, a network blip) — because every key carries this
 *     run's version suffix (see above), a failure partway through leaves at
 *     worst a PARTIAL set of new-version objects (orphaned, cheap, swept by
 *     the orphan-audit script) while the previous generation's icons stay
 *     exactly as they were, still fully live and referenced by
 *     `Store.pwaSettings`. A genuine StorageService `AppError` (503
 *     `STORAGE_NOT_CONFIGURED`, 400 `INVALID_FOLDER`/`MISSING_TENANT`, …)
 *     is re-thrown UNCHANGED instead of being masked as "your image is
 *     invalid", so an infra failure surfaces with its real status code
 *     (error-handler.ts escalates >=500 to Sentry) instead of a silent,
 *     unalerted 400. An unrecognized upload error becomes 502
 *     `ICON_UPLOAD_FAILED` — also not "your image is invalid".
 */
export async function generatePwaIconSet(
  storeId: string,
  sourceBuffer: Buffer,
  background: { r: number; g: number; b: number; alpha: number } = { r: 0, g: 0, b: 0, alpha: 0 }
): Promise<GeneratedPwaIcons> {
  // One version per generation run, shared by every uploaded key so the
  // whole set is internally consistent (and so a caller can tell which
  // generation a URL belongs to just by reading it). A timestamp alone can
  // collide when two generations land in the same millisecond (a merchant
  // double-clicking "save", or a fast test) — randomUUID guarantees a fresh
  // key every time regardless of timing.
  const version = randomUUID().slice(0, 8);

  let sourcePng: Buffer;
  const prepared: Array<{ target: (typeof ICON_TARGETS)[number]; buffer: Buffer }> = [];
  try {
    // Normalize the source as-is to PNG so the pipeline can be re-run later
    // against the original artwork without re-asking the merchant to
    // upload again.
    sourcePng = await sharp(sourceBuffer).png({ compressionLevel: 9 }).toBuffer();

    for (const target of ICON_TARGETS) {
      const innerSize = target.padded ? Math.floor(target.size * 0.8) : target.size;
      const pad = target.size - innerSize;

      const buf = await sharp(sourceBuffer, { density: Math.max(384, target.size * 2) })
        .resize(innerSize, innerSize, { fit: 'contain', background })
        .extend({
          top: Math.floor(pad / 2),
          bottom: Math.ceil(pad / 2),
          left: Math.floor(pad / 2),
          right: Math.ceil(pad / 2),
          background,
        })
        .png({ compressionLevel: 9 })
        .toBuffer();

      prepared.push({ target, buffer: buf });
    }
  } catch (err) {
    logger.error({ err, storeId }, 'pwa: icon set generation failed (image processing)');
    throw new AppError(
      400,
      'ICON_GENERATION_FAILED',
      'Could not process the uploaded icon. Use a valid square PNG, JPEG, WebP or SVG image.'
    );
  }

  const results: Partial<GeneratedPwaIcons> = {};
  try {
    const sourceUpload = await StorageService.upload(sourcePng, 'source.png', {
      folder: 'pwa',
      storeId,
      filename: `source-${version}`,
      contentType: 'image/png',
      allowedTypes: ['image/png'],
    });
    results.iconSource = sourceUpload.url;

    // Parallel, not sequential: the caller (POST /:storeId/pwa/icons) runs
    // under `tenantContext`, which holds one interactive Postgres
    // transaction open for the ENTIRE request — including this function's
    // R2 PUTs, which don't touch Postgres at all. Eight sequential round
    // trips extended that window to roughly 8x one target's latency, on a
    // transaction budgeted to time out at 30s (packages/database/src/index.ts).
    // Running the fixed, small ICON_TARGETS set concurrently instead cuts
    // that window to roughly 1x.
    await Promise.all(
      prepared.map(async ({ target, buffer }) => {
        const uploaded = await StorageService.upload(buffer, `${target.key}.png`, {
          folder: 'pwa',
          storeId,
          filename: `${target.key}-${version}`,
          contentType: 'image/png',
          allowedTypes: ['image/png'],
        });
        results[target.key] = uploaded.url;
      })
    );

    return results as GeneratedPwaIcons;
  } catch (err) {
    logger.error({ err, storeId }, 'pwa: icon set upload failed');
    // A StorageService AppError (503 STORAGE_NOT_CONFIGURED, 400
    // INVALID_FOLDER/MISSING_TENANT, …) already carries its real status
    // code and meaning — re-throw it unchanged rather than relabeling an
    // infra failure as "your image is invalid" (#1916).
    if (err instanceof AppError) throw err;
    throw new AppError(
      502,
      'ICON_UPLOAD_FAILED',
      'Could not upload the generated icons. Please try again.'
    );
  }
}

const DEFAULT_PWA_SETTINGS: PWASettings = {
  appName: '',
  shortName: '',
  description: '',
  themeColor: '#f97316', // Orange 500
  backgroundColor: '#ffffff',
  display: 'standalone',
  orientation: 'any',
  startUrl: '/',
  installPromptEnabled: true,
  offlineEnabled: true,
  pushNotificationsEnabled: false,
  iosStatusBarStyle: 'default',
  splashScreenColor: '#ffffff',
};

interface PWASettingsResponse {
  pwaEnabled: boolean;
  settings: PWASettings;
}

export class PWAService {
  /**
   * Get store PWA settings
   */
  static async getSettings(storeId: string): Promise<PWASettingsResponse> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        pwaEnabled: true,
        pwaSettings: true,
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    const storedSettings = (store.pwaSettings as Partial<PWASettings>) || {};
    const settings: PWASettings = {
      ...DEFAULT_PWA_SETTINGS,
      ...storedSettings,
      // Use store name as default if not set
      appName: storedSettings.appName || store.name,
      shortName: storedSettings.shortName || store.name.substring(0, 12),
      description: storedSettings.description || `Shop at ${store.name}`,
    };

    return {
      pwaEnabled: store.pwaEnabled,
      settings,
    };
  }

  /**
   * Update store PWA settings
   */
  static async updateSettings(
    storeId: string,
    data: { pwaEnabled?: boolean; settings?: Partial<PWASettings> }
  ): Promise<PWASettingsResponse> {
    // Verify store exists
    const existing = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, pwaSettings: true },
    });

    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    const currentSettings = {
      ...DEFAULT_PWA_SETTINGS,
      appName: existing.name,
      shortName: existing.name.substring(0, 12),
      description: `Shop at ${existing.name}`,
      ...(existing.pwaSettings as Partial<PWASettings>),
    };

    const updatedSettings = data.settings
      ? { ...currentSettings, ...data.settings }
      : currentSettings;

    const store = await prisma.store.update({
      where: { id: storeId },
      data: {
        pwaEnabled: data.pwaEnabled,
        pwaSettings: updatedSettings as unknown as Prisma.InputJsonValue,
      },
      select: {
        pwaEnabled: true,
        pwaSettings: true,
      },
    });

    // Every write here can change what /public/:storeId/manifest.json and
    // the storefront's home-screen icon look like. The manifest route itself
    // has no Redis cache today (see generateManifest below — not behind
    // getCached), so the only stale-read surface is the Next.js storefront's
    // own data-cache fetch (apps/web/src/app/manifest.ts, `next: { tags:
    // ['pwa:<storeId>'] }`). Bust that tag on every settings/icon write —
    // same pattern as invalidateStoreProductCaches's revalidateStorefront
    // call — so a merchant doesn't have to wait out the 300s TTL to see a
    // new icon or app name.
    revalidateStorefront({ tags: [`pwa:${storeId}`] });

    return {
      pwaEnabled: store.pwaEnabled,
      settings: store.pwaSettings as unknown as PWASettings,
    };
  }

  /**
   * Generate PWA manifest JSON
   */
  static async generateManifest(storeId: string): Promise<object | null> {
    const [store, pwaEnabled] = await Promise.all([
      prisma.store.findUnique({
        where: { id: storeId },
        select: {
          name: true,
          nameAr: true,
          pwaSettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'pwa'),
    ]);

    if (!store || !pwaEnabled) {
      return null;
    }

    const settings = {
      ...DEFAULT_PWA_SETTINGS,
      appName: store.name,
      shortName: store.name.substring(0, 12),
      description: `Shop at ${store.name}`,
      ...(store.pwaSettings as Partial<PWASettings>),
    };

    const manifest: Record<string, unknown> = {
      name: settings.appName,
      short_name: settings.shortName,
      description: settings.description,
      theme_color: settings.themeColor,
      background_color: settings.backgroundColor,
      display: settings.display,
      orientation: settings.orientation,
      start_url: settings.startUrl,
      scope: '/',
      icons: [],
    };

    // Arabic identity (#2194). The admin PWA tab authors appNameAr /
    // shortNameAr / descriptionAr, but the manifest used to emit only the
    // English fields, so an Arabic storefront's install prompt read English.
    // Emitted as EXTRA members alongside the standard ones (a browser ignores
    // unknown manifest members) rather than a `?lang=` variant, so the
    // storefront's single `pwa:<storeId>`-tagged fetch serves both locales and
    // updateSettings' tag bust still refreshes both at once. The storefront
    // (apps/web/src/app/manifest.ts) picks them under the `ar` locale.
    const authored = (store.pwaSettings ?? {}) as Partial<PWASettings>;
    const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const nameAr = clean(authored.appNameAr) ?? clean(store.nameAr);
    if (nameAr) {
      manifest.name_ar = nameAr;
      manifest.short_name_ar = clean(authored.shortNameAr) ?? nameAr.substring(0, 12);
    }
    manifest.description_ar = clean(authored.descriptionAr) ?? `تسوق في ${nameAr ?? store.name}`;

    // Add icons if available.
    //
    // BACKWARD COMPATIBILITY (binding — see the B5 plan + PR): a store that
    // has only ever set icon192/icon512 (the pre-B5 fields) MUST get back
    // EXACTLY today's two-entry array, in the same order, with no `purpose`
    // key on either entry. That's why icon192/icon512/icon384/iconAppleTouch/
    // favicon32/favicon16 are pushed with no `purpose` field at all (omitted,
    // not `purpose: 'any'` — adding that key would itself be a manifest
    // change for existing stores). The new B5 sizes just slot into the same
    // array shape; a store that hasn't uploaded them yet skips those entries
    // and the array collapses to exactly the legacy set.
    const icons: Array<{ src: string; sizes: string; type: string; purpose?: string }> = [];

    // Order follows the plan: favicons, apple-touch, then the Android sizes
    // smallest-to-largest. A legacy store (only icon192 + icon512 set, every
    // other field absent) collapses this to exactly [icon192, icon512] —
    // the same two entries in the same order the pre-B5 code produced.
    const sizedIconFields: Array<[keyof PWASettings, string]> = [
      ['favicon16', '16x16'],
      ['favicon32', '32x32'],
      ['iconAppleTouch', '180x180'],
      ['icon192', '192x192'],
      ['icon384', '384x384'],
      ['icon512', '512x512'],
    ];
    for (const [field, sizes] of sizedIconFields) {
      const src = settings[field];
      if (typeof src === 'string' && src) {
        icons.push({ src, sizes, type: 'image/png' });
      }
    }

    if (settings.maskableIcon) {
      icons.push({
        src: settings.maskableIcon,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      });
    }

    // Default icons if none provided
    if (icons.length === 0) {
      icons.push(
        {
          src: '/icons/icon-192x192.png',
          sizes: '192x192',
          type: 'image/png',
        },
        {
          src: '/icons/icon-512x512.png',
          sizes: '512x512',
          type: 'image/png',
        }
      );
    }

    manifest.icons = icons;

    return manifest;
  }

  /**
   * Generate service worker configuration
   */
  static async getServiceWorkerConfig(storeId: string): Promise<{
    enabled: boolean;
    offlineEnabled: boolean;
    pushEnabled: boolean;
  }> {
    const [store, pwaEnabled] = await Promise.all([
      prisma.store.findUnique({
        where: { id: storeId },
        select: {
          pwaSettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'pwa'),
    ]);

    if (!store || !pwaEnabled) {
      return {
        enabled: false,
        offlineEnabled: false,
        pushEnabled: false,
      };
    }

    const settings = (store.pwaSettings as Partial<PWASettings>) || {};

    return {
      enabled: true,
      offlineEnabled: settings.offlineEnabled ?? true,
      pushEnabled: settings.pushNotificationsEnabled ?? false,
    };
  }

  /**
   * Get iOS meta tags configuration
   */
  static async getIOSConfig(storeId: string): Promise<{
    enabled: boolean;
    statusBarStyle: string;
    splashColor: string;
    title: string;
  } | null> {
    const [store, pwaEnabled] = await Promise.all([
      prisma.store.findUnique({
        where: { id: storeId },
        select: {
          name: true,
          nameAr: true,
          pwaSettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'pwa'),
    ]);

    if (!store || !pwaEnabled) {
      return null;
    }

    const settings = {
      ...DEFAULT_PWA_SETTINGS,
      ...(store.pwaSettings as Partial<PWASettings>),
    };

    return {
      enabled: true,
      statusBarStyle: settings.iosStatusBarStyle,
      splashColor: settings.splashScreenColor,
      title: settings.appName || store.name,
    };
  }
}
