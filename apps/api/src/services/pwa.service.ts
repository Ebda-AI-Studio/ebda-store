import { randomUUID } from 'crypto';
import { pngDimensions, sniffImage } from '../lib/upload-sniff';
import { prisma, Prisma, withStore } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { featureService } from './feature.service';
import { StorageService } from './storage.service';
import { revalidateStorefront } from '../lib/revalidate-storefront';
import logger from '../lib/logger';
import { BRAND } from '@ebda/shared';
import { imagesBinding, renderIcon } from '../lib/images/icon-resizer';
import { redis } from './redis.service';
import { sendAlert } from './alerts.service';
import { storeUpdate } from '../lib/repo-factory';
import { withStoreRead } from '../lib/store-read';

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
 * The size keys of the icon set. With the Cloudflare Images binding (Ruling D1016-ICONS-1) each
 * key holds a PNG of its own `size`, and the maskable icon is `padded`: the art scaled into the
 * central 80% on the store's opaque PWA background (Android adaptive icon). Without the binding
 * (or when it fails) every key holds the source unchanged, as since FU46-8, and the browser
 * scales it.
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
 * Every target resized through Cloudflare Images, or null (no binding, or ANY target failed:
 * a mixed set of resized and pass-through icons is never stored). One warning on failure.
 */
/** Stable code for log drains and alert matching (review N3). */
export const PWA_ICON_RESIZE_FALLBACK = 'PWA_ICON_RESIZE_FALLBACK';

/**
 * A fallback is silent to the merchant (the icons still work), so it is made loud to us: a
 * structured warn with a stable `code`, a per-day counter (`metric:pwa-icon-resize-fallback:<day>`,
 * fixed 2-day window, readable with `redis.getRateLimitCount`), and ONE platform P1 per day — the
 * first fallback of the day — through `sendAlert` (its own 5-minute throttle is the second guard).
 * Never throws: reporting must not break the upload.
 */
async function reportResizeFallback(storeId: string, reason: string): Promise<void> {
  logger.warn(
    { code: PWA_ICON_RESIZE_FALLBACK, storeId, err: reason },
    'pwa: Cloudflare Images resize failed; storing the source under every size (FU46-8 fallback)'
  );
  const day = new Date().toISOString().slice(0, 10);
  const count = await redis
    .incrementFixedWindow(`metric:pwa-icon-resize-fallback:${day}`, 2 * 24 * 60 * 60)
    .catch(() => 0);
  if (count === 1)
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'pwa.icon-resize-fallback',
      title: 'PWA icons: Cloudflare Images resize falling back',
      body: `An icon upload fell back to storing the source under every size (${reason}). Check that Images is enabled on the account and the binding answers (Ruling D1016-ICONS-2). One alert per day; the day's count is in metric:pwa-icon-resize-fallback:${day}.`,
      context: { storeId, code: PWA_ICON_RESIZE_FALLBACK },
    }).catch(() => undefined);
}

/** One target rendered by a caller-supplied resizer (see `generatePwaIconSet`'s `resizer`). */
export type IconResizer = (
  source: Buffer,
  target: { size: number; padded: boolean },
  background: string | undefined
) => Promise<Buffer>;

async function resizeWith(
  resizer: IconResizer,
  source: Buffer,
  background: string | undefined
): Promise<Buffer[]> {
  return Promise.all(
    ICON_TARGETS.map(async t => {
      const out = await resizer(source, { size: t.size, padded: t.padded }, background);
      const dims = pngDimensions(out);
      if (!dims || dims.width !== t.size || dims.height !== t.size) {
        const messageEn = `Resizer answered ${dims ? `${dims.width}x${dims.height}` : 'a non-PNG'} for ${t.size}px`;
        throw new AppError(400, 'ICON_GENERATION_FAILED', messageEn, { messageEn });
      }
      return out;
    })
  );
}

/** How long the whole Images resize may take before the set falls back (review M1). */
export const IMAGES_DEADLINE_MS = 10_000;

async function resizedTargets(
  storeId: string,
  source: Buffer,
  background: string | undefined,
  deadlineMs: number = IMAGES_DEADLINE_MS
): Promise<Buffer[] | null> {
  const images = imagesBinding();
  if (!images) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const all = Promise.all(
      ICON_TARGETS.map(t => renderIcon(images, source, t.size, { maskable: t.padded, background }))
    );
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Images resize missed its ${deadlineMs}ms deadline`)),
        deadlineMs
      );
    });
    return await Promise.race([all, deadline]);
  } catch (err) {
    await reportResizeFallback(storeId, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Store the PWA icon set from one merchant-uploaded square PNG under `stores/<storeId>/pwa/`.
 *
 * Workers-safe: no image library runs here (`sharp` cannot load on workerd, FU46-8). The route has
 * already checked the source is a square PNG of at least 512×512 and at most 1 MB from its bytes;
 * this function re-checks it is a PNG (defence in depth: it is exported), stores the source as
 * sent, and stores each target RESIZED through the Cloudflare Images binding (Ruling
 * D1016-ICONS-1, the maskable one padded) — or, with no binding or any resize failure, the SAME
 * source bytes under every target key, as FU46-8 did. `Content-Type: image/png` throughout.
 *
 * Every key carries a per-generation VERSION suffix (`icon192-<ver>`): `StorageService` sets a
 * one-year `Cache-Control`, so a fixed key kept serving the old icon after a re-upload (#1912),
 * and a fresh key per run means a mid-run failure never overwrites an icon that is live and
 * referenced by `Store.pwaSettings` (#1913). The route deletes the previous generation once the
 * new URLs are persisted (`cleanupRemovedJsonUrls`, issue 2201); a failed run leaves orphaned
 * new-version objects that the R2 orphan sweep reports.
 *
 * Errors: a non-PNG source is a 400 `ICON_GENERATION_FAILED` before any upload. A
 * StorageService `AppError` (503 `STORAGE_NOT_CONFIGURED`, 400 `INVALID_FOLDER`, ...) is re-thrown
 * unchanged (#1916); any other upload failure is a 502 `ICON_UPLOAD_FAILED`, never "your image is
 * invalid". The target uploads run concurrently: the caller holds a request transaction open
 * across them (#1914).
 */
export async function generatePwaIconSet(
  storeId: string,
  sourceBuffer: Buffer,
  /**
   * `background`: the maskable icon's padding colour (the store's PWA background).
   * `deadlineMs`: the Images resize deadline (default IMAGES_DEADLINE_MS; tests shorten it).
   */
  opts: {
    background?: string;
    deadlineMs?: number;
    /**
     * Replaces the Images binding: the Node backfill script (scripts/backfill-store-pwa-icons.ts)
     * has no binding and must not store the 512px source under the 16px favicon key. Every answer
     * is checked for its exact size; a wrong one aborts the run before any upload.
     */
    resizer?: IconResizer;
  } = {}
): Promise<GeneratedPwaIcons> {
  // One version per run, shared by every key (randomUUID: two runs in one millisecond differ).
  const version = randomUUID().slice(0, 8);

  if (sniffImage(sourceBuffer) !== 'image/png') {
    logger.warn({ storeId }, 'pwa: icon source is not a PNG');
    const messageEn = 'The icon must be a square PNG image.';
    throw new AppError(400, 'ICON_GENERATION_FAILED', messageEn, {
      messageEn,
      messageAr: 'الأيقونة لازم تكون صورة PNG مربعة.',
    });
  }
  const sourcePng = sourceBuffer;
  const resized = opts.resizer
    ? await resizeWith(opts.resizer, sourceBuffer, opts.background)
    : await resizedTargets(storeId, sourceBuffer, opts.background, opts.deadlineMs);
  const prepared = ICON_TARGETS.map((target, i) => ({
    target,
    buffer: resized ? resized[i] : sourceBuffer,
  }));

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
  themeColor: BRAND.colors.night, // Ebda night (Ruling D1016-ORANGE-1)
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
    const store = await withStoreRead(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: {
          name: true,
          pwaEnabled: true,
          pwaSettings: true,
        },
      })
    );

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
    const existing = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, pwaSettings: true },
      })
    );

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

    const store = await withStore(storeId, tx =>
      storeUpdate(tx, {
        where: { id: storeId },
        data: {
          pwaEnabled: data.pwaEnabled,
          pwaSettings: updatedSettings as unknown as Prisma.InputJsonValue,
        },
        select: {
          pwaEnabled: true,
          pwaSettings: true,
        },
      })
    );

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
      withStoreRead(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: {
            name: true,
            nameAr: true,
            pwaSettings: true,
          },
        })
      ),
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
      withStoreRead(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: {
            pwaSettings: true,
          },
        })
      ),
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
      withStoreRead(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: {
            name: true,
            nameAr: true,
            pwaSettings: true,
          },
        })
      ),
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
