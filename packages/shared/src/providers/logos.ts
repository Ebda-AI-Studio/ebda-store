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
export interface ProviderLogoEntry {
  /** Public path of the vendored asset, or null for the wordmark tile. */
  asset: string | null;
  /** Why there is no asset (null when there is one). */
  missing: 'brand-kit-needed' | 'not-a-brand' | null;
}

const asset = (code: string): ProviderLogoEntry => ({
  asset: `/provider-logos/${code}.webp`,
  missing: null,
});

export const PROVIDER_LOGOS: Record<string, ProviderLogoEntry> = {
  paymob: asset('paymob'),
  kashier: asset('kashier'),
  fawry: asset('fawry'),
  instapay: asset('instapay'),
  bosta: asset('bosta'),
  shipblu: asset('shipblu'),
  mylerz: asset('mylerz'),
  aramex: asset('aramex'),
  // No official asset in the repo: Ahmad to supply from the provider brand kit.
  geidea: { asset: null, missing: 'brand-kit-needed' },
  // Social platforms (social links, branding): no official asset in the repo, so wordmark tiles.
  // Official marks come from each platform's brand kit (Ahmad to supply); never drawn or downloaded here.
  instagram: { asset: null, missing: 'brand-kit-needed' },
  facebook: { asset: null, missing: 'brand-kit-needed' },
  twitter: { asset: null, missing: 'brand-kit-needed' },
  tiktok: { asset: null, missing: 'brand-kit-needed' },
  youtube: { asset: null, missing: 'brand-kit-needed' },
  snapchat: { asset: null, missing: 'brand-kit-needed' },
  linkedin: { asset: null, missing: 'brand-kit-needed' },
  whatsapp: { asset: null, missing: 'brand-kit-needed' },
  // Not brands: generic methods.
  cod: { asset: null, missing: 'not-a-brand' },
  manual: { asset: null, missing: 'not-a-brand' },
};

/** Registry keys that are social platforms, not catalog providers. */
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
