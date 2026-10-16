import { API_URL } from './api';

/** What the PDP trust line needs to say "cash on delivery": the merchant's own names. */
export interface CodOffer {
  name: string | null;
  nameAr: string | null;
}

/**
 * Server-side: does this store offer cash on delivery right now? Read from the
 * store's own `/payments/config` (the checkout's source) while the PDP renders,
 * so the trust line is in the server HTML and never inserted after load (W1c
 * review I5: the client fetch shifted the layout under the buy button).
 *
 * Freshness: read per request (`no-store`), the same as the per-mount client
 * read it replaces; the PDP is already request-rendered (the store resolver
 * reads headers). Never throws: unknown = `null` = no COD claim.
 */
export async function fetchCodOffer(store: {
  id: string;
  domain?: string | null;
}): Promise<CodOffer | null> {
  if (!store.id || store.id === 'demo') return null;
  try {
    const res = await fetch(`${API_URL}/payments/config`, {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Store-ID': store.id,
        ...(store.domain ? { 'x-store-domain': store.domain } : {}),
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      success?: boolean;
      data?: { cod?: { displayName?: unknown; displayNameAr?: unknown } | null };
    };
    const cod = json?.success ? json.data?.cod : null;
    if (!cod || typeof cod !== 'object') return null;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return { name: str(cod.displayName), nameAr: str(cod.displayNameAr) };
  } catch {
    return null;
  }
}
