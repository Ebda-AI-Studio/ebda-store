import { z } from 'zod/v3';
import { phoneOrBlankSchema } from './phone';

/**
 * Canonical Egypt address schema — shared across all three address Zod
 * definitions that previously drifted:
 *   - apps/api/src/routes/address.routes.ts   (user saved-address book)
 *   - apps/api/src/routes/public.routes.ts    (checkout shipping address)
 *   - apps/api/src/routes/order.routes.ts     (admin manual order form)
 *
 * The BUG fixed here: address.routes.ts was missing `governorate` /
 * `governorateAr` / `areaAr`, so those fields were silently stripped when a
 * customer saved an address after the GovernorateAreaSelect checkout step.
 *
 * Field notes:
 *  - `governorate` / `governorateAr`: one of the 27 Egyptian governorates
 *    (`REGION.governorates`, e.g. Cairo / القاهرة).
 *  - `area` / `areaAr`: city or district within the governorate (e.g. Maadi).
 *  - `state`: legacy/generic field kept for backwards compat; overlaps `area`
 *    in older orders.  Both are accepted simultaneously.
 *  - `city`: free-text city/town; accepted but defaults to '' so the checkout
 *    never 400s on an empty value.
 *  - `address1`: street + building; `address2`: floor / apartment / landmark.
 *  - `postalCode`: optional (Egyptian postal codes are rarely used).
 *  - `phone`: an Egyptian mobile (`REGION.phone`), normalised client-side to
 *    `+20…`; the schema stays permissive (any plausible phone string) so a
 *    legacy or foreign number never blocks checkout.
 */
export const egyptAddressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  address1: z.string().trim().min(1).max(500),
  address2: z.string().max(500).optional(),
  city: z.string().trim().max(150).optional().default(''),
  governorate: z.string().max(60).optional().default(''),
  governorateAr: z.string().max(60).optional().default(''),
  area: z.string().max(150).optional().default(''),
  areaAr: z.string().max(150).optional().default(''),
  state: z.string().max(150).optional().default(''),
  postalCode: z.string().max(30).optional().default(''),
  // Structured Egyptian delivery details (also folded into address1 by the
  // storefront for display back-compat). Optional so older clients still pass.
  street: z.string().max(200).optional(),
  building: z.string().max(100).optional(),
  floor: z.string().max(50).optional(),
  apartment: z.string().max(50).optional(),
  country: z.string().trim().min(2).max(60),
  phone: phoneOrBlankSchema.optional(),
});
export type EgyptAddressInput = z.infer<typeof egyptAddressSchema>;

// Optional http(s) URL. `null` (or '') clears the stored value on an UPDATE;
// an omitted key leaves it alone. See the nullability note on
// `locationInputSchema` below.
const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine(u => /^https?:\/\//i.test(u), 'URL must be http(s)')
  .nullable()
  .optional()
  .or(z.literal('').transform(() => null));

/**
 * Branch/location input, shared by the admin CREATE (POST) and the
 * `.partial()` UPDATE (PUT).
 *
 * Every optional column is `.nullable()` so an emptied field on the edit form
 * can CLEAR it: Prisma reads `null` as "set to NULL" and `undefined` (an
 * omitted key) as "leave alone". Without the null form the admin's clear
 * silently no-ops — the PUT succeeds and the old text survives.
 * `name` / `country` / `address` are required and have no null form.
 */
export const locationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  nameAr: z.string().trim().max(200).nullable().optional(),
  country: z.string().trim().min(1).max(100),
  countryAr: z.string().trim().max(100).nullable().optional(),
  address: z.string().trim().min(1).max(500),
  addressAr: z.string().trim().max(500).nullable().optional(),
  phone: phoneOrBlankSchema.nullable().optional(),
  whatsapp: phoneOrBlankSchema.nullable().optional(),
  mapsUrl: httpsUrl,
  mapsEmbedUrl: httpsUrl,
  hours: z.string().trim().max(200).nullable().optional(),
  hoursAr: z.string().trim().max(200).nullable().optional(),
  isPublished: z.boolean().optional().default(true),
  position: z.number().int().min(0).max(10_000).optional().default(0),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

/**
 * Narrow, storefront-safe projection of a `StoreLocation` row — the shape
 * threaded through the public store-resolve payload (`/public/store/resolve`,
 * `/public/stores/:slugOrId`) into `FooterProps.locations` for the opt-in
 * "Branches" footer column (B3, 2026-09). Deliberately drops fields the
 * footer doesn't render (`country`, `whatsapp`, `hours`, `mapsEmbedUrl`,
 * `isPublished`, `position`) to keep the per-page store payload small — the
 * dedicated `/public/:storeId/locations` endpoint (the `/locations` page)
 * still returns the full row.
 */
export interface StoreLocationPublic {
  id: string;
  name: string;
  nameAr?: string | null;
  address: string;
  addressAr?: string | null;
  phone?: string | null;
  mapsUrl?: string | null;
}

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
