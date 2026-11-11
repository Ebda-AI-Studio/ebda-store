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
