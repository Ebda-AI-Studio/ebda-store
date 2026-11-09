import { z } from 'zod/v3';

/**
 * The per-store PWA manifest the API builds from a merchant's PWA settings
 * (`GET /stores/public/:storeId/manifest.json`, PWAService.generateManifest), as the storefront
 * accepts it before serving it to a browser (apps/web/src/app/manifest.ts).
 *
 * The values are merchant input. A manifest that fails this schema is not served: the storefront
 * falls back to its own generic manifest, so a broken merchant manifest is never worse than none.
 *
 * - `start_url` and `scope` are paths on the store's own origin: one leading `/`, never `//host`,
 *   a scheme or a backslash (a browser reads `/\host` as `//host`).
 * - an icon is a merchant upload, so an absolute `https:` URL. A relative path is refused: the API
 *   cannot know which static files the storefront ships.
 * - a colour is a hex colour, which is what the admin colour picker stores.
 */
const sameOriginPath = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)[^\\]*$/);

const hexColour = z.string().regex(/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);

const httpsUrl = z
  .string()
  .max(2048)
  .refine(value => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });

/** Blank and whitespace-only read as absent, so the storefront's own fallback applies. */
const label = z.string().max(200).trim().optional();
const longText = z.string().max(1000).trim().optional();

export const storePwaManifestSchema = z.object({
  name: label,
  short_name: label,
  description: longText,
  name_ar: label,
  short_name_ar: label,
  description_ar: longText,
  theme_color: hexColour.optional(),
  background_color: hexColour.optional(),
  display: z.enum(['fullscreen', 'standalone', 'minimal-ui', 'browser']).optional(),
  orientation: z.enum(['any', 'portrait', 'landscape']).optional(),
  start_url: sameOriginPath.optional(),
  scope: sameOriginPath.optional(),
  icons: z
    .array(
      z.object({
        src: httpsUrl,
        sizes: z.string().regex(/^\d{1,4}x\d{1,4}$/),
        type: z.string().regex(/^image\/[a-z0-9.+-]+$/i),
        purpose: z.string().max(40).optional(),
      })
    )
    .max(16)
    .optional(),
});

export type StorePwaManifest = z.infer<typeof storePwaManifestSchema>;
