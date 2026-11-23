/**
 * The Branding page loads name / nameAr / description / descriptionAr / logo / logoAr / favicon once, then saves ONE bundle.
 * It used to send ALL of them on every save, so editing only the theme (or only the English name) wrote the Arabic copy
 * back from the copy loaded at mount: an Arabic name filled in meanwhile (the translate-missing button on another tab, a
 * second admin, the fill-only AI writers) was silently reverted. Same class as `themePatch`: send only the keys the
 * merchant changed here. A cleared field is sent as '' (the API clears it); an unchanged one is not sent at all.
 */
const BRANDING_KEYS = [
  'name',
  'nameAr',
  'logo',
  'logoAr',
  'favicon',
  'description',
  'descriptionAr',
] as const;

type BrandingKey = (typeof BRANDING_KEYS)[number];
type BrandingFields = Partial<Record<BrandingKey, string | null | undefined>>;

export function brandingPatch(
  loaded: BrandingFields,
  current: BrandingFields
): Partial<Record<BrandingKey, string>> {
  const patch: Partial<Record<BrandingKey, string>> = {};
  for (const key of BRANDING_KEYS) {
    const was = loaded[key] ?? '';
    const now = current[key] ?? '';
    if (was !== now) patch[key] = now;
  }
  return patch;
}

/**
 * Same rule for the other objects the page saves (contact columns, social links, `settings.contact`): a key travels only if
 * the merchant changed it here, so a value set meanwhile on another page (SEO sets `wikidata` / `wikipedia`) is not reverted
 * from the copy loaded at mount. A cleared key is sent as '' for contact/social (the API clears it) and as null inside
 * `settings.contact` (the server merge deletes it).
 */
const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '');

export function keyPatch(
  loaded: Record<string, unknown>,
  current: Record<string, unknown>,
  keys: readonly string[] = [...new Set([...Object.keys(loaded), ...Object.keys(current)])]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (!same(loaded[k], current[k])) out[k] = String(current[k] ?? '');
  return out;
}

export const CONTACT_KEYS = [
  'email',
  'phone',
  'phoneAr',
  'whatsapp',
  'address',
  'addressAr',
] as const;

/** `settings.contact` keys this page owns: addressUrl (null = delete) and addressLink (boolean). */
export function settingsContactPatch(
  loaded: { addressUrl?: string | null; addressLink?: boolean },
  current: { addressUrl?: string | null; addressLink?: boolean }
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const url = current.addressUrl?.trim() || null;
  if ((loaded.addressUrl?.trim() || null) !== url) out.addressUrl = url;
  const link = current.addressLink !== false;
  if ((loaded.addressLink !== false) !== link) out.addressLink = link;
  return out;
}
