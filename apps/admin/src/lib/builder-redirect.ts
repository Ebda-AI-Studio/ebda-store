/**
 * Where the retired form page builder (and the old hero / navigation / pages editors) send a visitor:
 * the visual editor, keeping the deep link (Ruling VE-16: `select`, `block`, `field`, `page`). Any
 * other query param is dropped.
 */
const DEEP_LINK_PARAMS = ['select', 'block', 'field', 'page'] as const;

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function builderRedirectPath(storeId: string, search: RawSearchParams = {}): string {
  const qs = DEEP_LINK_PARAMS.flatMap(key => {
    const raw = search[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value ? [`${key}=${encodeURIComponent(value)}`] : [];
  }).join('&');
  return `/stores/${storeId}/builder${qs ? `?${qs}` : ''}`;
}
