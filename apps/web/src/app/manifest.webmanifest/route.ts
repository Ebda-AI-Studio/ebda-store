import { buildStoreManifest } from '../../lib/pwa/store-manifest';

/**
 * `/manifest.webmanifest`: the store's web app manifest (Ruling PWA-MANIFEST-2).
 *
 * A hand-written route, not the `app/manifest.ts` file convention: that convention always overrides the
 * `manifest` the root layout puts in its metadata, so no page could link a manifest in its own language.
 * `/ar/manifest.webmanifest` and `/en/manifest.webmanifest` are rewritten here by the middleware with the
 * language on the request; the bare path answers in the store's default language.
 *
 * The body and the two headers are what the file convention produced (`JSON.stringify` of the object,
 * `application/manifest+json`, revalidate on every use), so the bare URL's answer does not change.
 */
export async function GET(): Promise<Response> {
  return new Response(JSON.stringify(await buildStoreManifest()), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
