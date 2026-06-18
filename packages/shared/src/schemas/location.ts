import { z } from 'zod';

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine(u => /^https?:\/\//i.test(u), 'URL must be http(s)')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const locationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  nameAr: z.string().trim().max(200).optional(),
  country: z.string().trim().min(1).max(100),
  countryAr: z.string().trim().max(100).optional(),
  address: z.string().trim().min(1).max(500),
  addressAr: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(40).optional(),
  whatsapp: z.string().trim().max(40).optional(),
  mapsUrl: httpsUrl,
  mapsEmbedUrl: httpsUrl,
  hours: z.string().trim().max(200).optional(),
  hoursAr: z.string().trim().max(200).optional(),
  isPublished: z.boolean().optional().default(true),
  position: z.number().int().min(0).max(10_000).optional().default(0),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Build a Google Maps iframe `src` that actually renders an inline map WITHOUT a
 * Maps Embed API key.
 *
 * The merchant enters a normal Google Maps SHARE/search link in `mapsUrl`
 * (e.g. `https://maps.google.com/?q=...`, `https://www.google.com/maps/place/...`,
 * a `goo.gl/maps` short link, etc.). Such links CANNOT be dropped directly into
 * an `<iframe>` — Google serves them with `X-Frame-Options`, so the iframe renders
 * a blank white box. The embeddable form is `?q=<query-or-latlng>&output=embed`,
 * which Google serves frame-able and key-free.
 *
 * Resolution order:
 *  1. `mapsEmbedUrl` that is already a genuine embed (`/maps/embed` pb-form, or any
 *     URL that already carries `output=embed`) → used verbatim.
 *  2. Latitude/longitude parsed out of `mapsUrl` (`@lat,lng` or `q=lat,lng` / `ll=`)
 *     → `?q=<lat,lng>&output=embed`.
 *  3. A place/search query parsed out of `mapsUrl` (`q=`, `query=`, or `/place/<name>`)
 *     → `?q=<query>&output=embed`.
 *  4. A free-text `fallbackQuery` (typically the branch address) → `?q=<query>&output=embed`.
 *
 * Returns `undefined` when nothing usable is available (caller keeps the placeholder).
 * The result is always an `https://www.google.com/maps?...&output=embed` URL, so the
 * caller can render it safely (https-only, no key, frame-able).
 */
export function mapsEmbedSrc(opts: {
  mapsUrl?: string | null;
  mapsEmbedUrl?: string | null;
  fallbackQuery?: string | null;
}): string | undefined {
  const isHttps = (u: string): boolean => /^https:\/\//i.test(u.trim());
  const embed = (query: string): string =>
    `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;

  // 1. An explicit, already-embeddable URL — use as-is, but ONLY when it's a
  // genuine Google Maps host. The merchant supplies this value, so validate the
  // hostname against an exact allowlist (not a substring) before rendering it in
  // an <iframe> — otherwise `https://evil.com/maps/embed` would be trusted.
  const explicit = opts.mapsEmbedUrl?.trim();
  if (explicit && isHttps(explicit)) {
    try {
      const eu = new URL(explicit);
      const host = eu.hostname.toLowerCase();
      const okHost =
        host === 'www.google.com' || host === 'maps.google.com' || host === 'google.com';
      const okPath =
        /^\/maps\/embed(\/|$)/i.test(eu.pathname) || eu.searchParams.get('output') === 'embed';
      if (okHost && okPath) {
        return explicit;
      }
    } catch {
      /* malformed URL — fall through to share-link parsing below */
    }
  }

  // 2 + 3. Try to parse coordinates or a query out of the share link.
  const share = opts.mapsUrl?.trim();
  if (share && isHttps(share)) {
    try {
      const u = new URL(share);
      const latLngRe = /(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/;

      // `@lat,lng` in the path (the most common /maps/place/... share shape).
      const pathMatch = u.pathname.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
      if (pathMatch) return embed(`${pathMatch[1]},${pathMatch[2]}`);

      // Coordinates in a query param (`q=lat,lng`, `ll=lat,lng`, `query=lat,lng`).
      for (const key of ['q', 'query', 'll', 'center', 'destination']) {
        const v = u.searchParams.get(key);
        if (v) {
          const m = v.match(latLngRe);
          if (m) return embed(`${m[1]},${m[2]}`);
        }
      }

      // A textual query param (place name / address).
      for (const key of ['q', 'query', 'destination']) {
        const v = u.searchParams.get(key)?.trim();
        if (v) return embed(v);
      }

      // `/maps/place/<name>` with no coords/query params.
      const placeMatch = u.pathname.match(/\/maps\/place\/([^/]+)/i);
      if (placeMatch) {
        const place = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
        if (place) return embed(place);
      }
    } catch {
      // Malformed URL — fall through to the address fallback.
    }
  }

  // 4. Last resort — geocode the branch address (or any free-text query).
  const fallback = opts.fallbackQuery?.trim();
  if (fallback) return embed(fallback);

  return undefined;
}
