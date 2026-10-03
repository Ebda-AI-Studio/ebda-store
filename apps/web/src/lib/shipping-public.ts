import { API_URL } from './api';
import type { PublicShippingZone } from './structured-data';

/**
 * Shipping rates for the storefront's JSON-LD shipping block.
 *
 * TWO SOURCES, and both are required. FWB has two shipping models:
 *   - `ShippingZone`     — named zones, carry a delivery-day estimate
 *   - `ShippingAreaRate` — per-governorate/area rates, no day estimate
 *
 * Real merchants overwhelmingly use AREA RATES: that is what the admin's
 * `AreaRateEditor` writes, and Pecannbee (the reference store) has a full
 * Egypt area list with ZERO zones. Reading zones alone shipped a block that
 * was silently dead for every such store — the fetch succeeded, returned an
 * empty list, and the block was correctly-but-uselessly omitted forever.
 *
 * MOUNT PATH: shipping routes are mounted under `/stores`, so the public
 * endpoints are `/stores/public/:storeId/shipping[...]` — NOT
 * `/public/:storeId/shipping`. The wrong path 404s, and because this helper
 * swallows failures by design that degrades to silence rather than an error,
 * which is exactly why the first version looked fine in tests and did nothing
 * in production.
 *
 * Never throws: shipping detail is an SEO/agent enhancement and must not turn a
 * product page into a 500. Each source degrades independently.
 */
async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchPublicShippingZones(storeId: string): Promise<PublicShippingZone[]> {
  if (!storeId || storeId === 'demo') return [];
  const base = `${API_URL}/stores/public/${encodeURIComponent(storeId)}/shipping`;

  const [zonesJson, ratesJson] = await Promise.all([
    fetchJson(base),
    fetchJson(`${base}/area-rates`),
  ]);

  const out: PublicShippingZone[] = [];

  const zones = (zonesJson as { data?: { zones?: unknown } } | null)?.data?.zones;
  if (Array.isArray(zones)) {
    for (const z of zones as Array<Record<string, unknown>>) {
      out.push({
        name: String(z.name ?? ''),
        deliveryFee: Number(z.deliveryFee ?? 0),
        freeShippingThreshold: (z.freeShippingThreshold as number | null) ?? null,
        estimatedDaysMin: (z.estimatedDaysMin as number | null) ?? null,
        estimatedDaysMax: (z.estimatedDaysMax as number | null) ?? null,
        estimatedDays: (z.estimatedDays as number | null) ?? null,
      });
    }
  }

  const rates = (ratesJson as { data?: { rates?: unknown } } | null)?.data?.rates;
  if (Array.isArray(rates)) {
    for (const r of rates as Array<Record<string, unknown>>) {
      out.push({
        name: String(r.area ?? r.governorate ?? ''),
        deliveryFee: Number(r.deliveryFee ?? 0),
        freeShippingThreshold: (r.freeShippingThreshold as number | null) ?? null,
        // Area rates carry no delivery estimate. Keeping these null makes
        // `shippingDetailsJsonLd` omit `deliveryTime` instead of inventing one.
        estimatedDaysMin: null,
        estimatedDaysMax: null,
        estimatedDays: null,
      });
    }
  }

  return out;
}
