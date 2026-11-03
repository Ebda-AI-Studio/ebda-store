/**
 * Keys of the merchant-writable `stores.settings` JSON that the SERVER owns. Settings are written by
 * the store owner through the store create/update routes with arbitrary keys, so anything that is an
 * entitlement or a link state must never live in there: a merchant could switch it on.
 *
 * `ebdaWhatsApp` was the (never shipped) home of the Ebda Chat link flag; the link now lives in
 * the server-only `store_whatsapp_links` table. The key stays reserved so no client can plant it and
 * no old reader can be fooled by it. (The legacy bridge's receiver-URL key was reserved here too until
 * the bridge was deleted, Ruling WA-LEGACY-1; nothing reads it any more.) Swept 2026-10-25:
 * no other server-owned flag lives in settings (plan, limits, feature flags and verification state
 * are columns / StoreFeature rows).
 *
 * `goldAllowDeferredPayment` (Ruling SHARIA-GOLD-1) is a merchant choice that needs an explicit confirm and
 * an audit row, so it is written only by `PUT /stores/:id/gold-rates/payment-policy`, never the generic route.
 */
export const SERVER_OWNED_SETTINGS_KEYS = ['ebdaWhatsApp', 'goldAllowDeferredPayment'] as const;

export function reservedSettingsKeys(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
  return SERVER_OWNED_SETTINGS_KEYS.filter(k => k in (settings as Record<string, unknown>));
}

/** A copy of client-supplied settings without the reserved keys. */
export function stripServerOwnedSettings<T extends Record<string, unknown>>(settings: T): T {
  const out: Record<string, unknown> = { ...settings };
  for (const k of SERVER_OWNED_SETTINGS_KEYS) delete out[k];
  return out as T;
}

/**
 * The settings to store: the client's keys (reserved ones dropped) over the existing ones, with the
 * SERVER's reserved values restored, so an update can neither add nor change nor erase them.
 */
export function mergeClientSettings(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const base = existing ?? {};
  const merged: Record<string, unknown> = { ...base, ...stripServerOwnedSettings(incoming) };
  for (const k of SERVER_OWNED_SETTINGS_KEYS) {
    if (k in base) merged[k] = base[k];
    else delete merged[k];
  }
  return merged;
}
