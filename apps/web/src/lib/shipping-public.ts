import { API_URL } from './api';
import type { PublicShippingZone } from './structured-data';

/**
 * Shipping zones for the storefront's JSON-LD shipping block.
 *
 * Uses the EXISTING public endpoint (`GET /public/:storeId/shipping`) — this
 * feature needed no new API surface, only a machine-readable rendering of data
 * the merchant already configured.
 *
 * Never throws. Shipping detail is an SEO/agent enhancement, so a transient
 * failure here must not 500 a product page — contrast `fetchInitialProduct`,
 * where a fetch failure deliberately propagates so a transient error can't be
 * mistaken for a genuine 404. On failure we return `[]` and
 * `shippingDetailsJsonLd` omits the block entirely.
 *
 * Cached for an hour: zones change rarely, and a stale delivery fee in JSON-LD
 * is far less costly than an extra API round-trip on every product render.
 */
export async function fetchPublicShippingZones(storeId: string): Promise<PublicShippingZone[]> {
  if (!storeId || storeId === 'demo') return [];
  try {
    const res = await fetch(`${API_URL}/public/${encodeURIComponent(storeId)}/shipping`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const zones = json?.data?.zones;
    if (!Array.isArray(zones)) return [];

    return zones.map((z: Record<string, unknown>) => ({
      name: String(z.name ?? ''),
      deliveryFee: Number(z.deliveryFee ?? 0),
      freeShippingThreshold: (z.freeShippingThreshold as number | null) ?? null,
      estimatedDaysMin: (z.estimatedDaysMin as number | null) ?? null,
      estimatedDaysMax: (z.estimatedDaysMax as number | null) ?? null,
      estimatedDays: (z.estimatedDays as number | null) ?? null,
    }));
  } catch {
    return [];
  }
}
