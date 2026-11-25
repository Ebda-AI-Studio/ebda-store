/**
 * Provider logo registry: ONE place that says how each catalog provider is drawn in the admin.
 *
 * `asset` = a file already vendored in the repo (copied from apps/marketing/public/logos, see
 * SOURCES.md next to the files); it is a path under `/provider-logos/` served by the admin app.
 * `asset: null` = no official asset in the repo yet -> the UI draws a neutral text wordmark tile
 * (name in a pill). We never draw imitations of a brand mark.
 *
 * `logos.test.ts` fails when a provider is added to PROVIDER_CATALOG without an entry here.
 */
// pq-allow(unused-export): the declared return type of getProviderLogo (a declaration cannot name a private type)
export interface ProviderLogoEntry {
  /** Public path of the vendored asset, or null for the wordmark tile. */
  asset: string | null;
  /** Why there is no asset (null when there is one). */
  missing: 'brand-kit-needed' | 'not-a-brand' | null;
}

const asset = (code: string, ext: 'webp' | 'svg' = 'webp'): ProviderLogoEntry => ({
  asset: `/provider-logos/${code}.${ext}`,
  missing: null,
});

// pq-allow(unused-export): test seam, imported by packages/shared/src/providers/logos.test.ts
export const PROVIDER_LOGOS: Record<string, ProviderLogoEntry> = {
  paymob: asset('paymob'),
  kashier: asset('kashier'),
  fawry: asset('fawry'),
  instapay: asset('instapay'),
  bosta: asset('bosta'),
  shipblu: asset('shipblu'),
  mylerz: asset('mylerz'),
  aramex: asset('aramex'),
  // Geidea: official logo SVG from geidea.net's own asset CDN (no public brand kit page exists; see SOURCES.md).
  geidea: asset('geidea', 'svg'),
  // Social platforms: official marks from each platform's brand-resource page, unaltered (see SOURCES.md).
  instagram: asset('instagram'),
  facebook: asset('facebook'),
  twitter: asset('twitter', 'svg'),
  tiktok: asset('tiktok'),
  youtube: asset('youtube'),
  // Snapchat: the official Ghost-logo download on snap.com/brand-guidelines returns 403 (AccessDenied),
  // so there is no official file yet: wordmark tile until Snap's asset link is fixed or Ahmad supplies it.
  snapchat: { asset: null, missing: 'brand-kit-needed' },
  linkedin: asset('linkedin'),
  whatsapp: asset('whatsapp', 'svg'),
  // Not brands: generic methods.
  cod: { asset: null, missing: 'not-a-brand' },
  manual: { asset: null, missing: 'not-a-brand' },
};

/** Registry keys that are social platforms, not catalog providers. */
// pq-allow(unused-export): test seam, imported by apps/admin/src/components/ProviderLogo.test.tsx and packages/shared/src/providers/logos.test.ts
export const SOCIAL_LOGO_CODES = [
  'instagram',
  'facebook',
  'twitter',
  'tiktok',
  'youtube',
  'snapchat',
  'linkedin',
  'whatsapp',
] as const;

export function getProviderLogo(code: string): ProviderLogoEntry {
  return Object.prototype.hasOwnProperty.call(PROVIDER_LOGOS, code)
    ? PROVIDER_LOGOS[code]
    : { asset: null, missing: 'brand-kit-needed' };
}
