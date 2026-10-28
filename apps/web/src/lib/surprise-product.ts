/**
 * "Surprise me" on a store's 404: one random IN-STOCK product of THAT store.
 *
 * Uses the public product list the storefront already serves (tenant-scoped by the Host): one probe for
 * the total, then one random page, and a client-side pick among the products the server flagged in stock
 * (`inStock`, the aggregate over variants). No new endpoint, no cross-store data. Returns null when the
 * store has nothing in stock.
 */
export interface SurpriseCandidate {
  slug: string;
  /** Server-computed aggregate; `undefined` (an old payload) is treated as in stock. */
  inStock?: boolean;
  status?: string;
}

export interface SurprisePage {
  products: SurpriseCandidate[];
  total: number;
}

const PAGE_SIZE = 24;

const buyable = (p: SurpriseCandidate): boolean =>
  !!p.slug && p.inStock !== false && (p.status === undefined || p.status === 'active');

export async function findSurpriseSlug(
  fetchPage: (page: number, limit: number) => Promise<SurprisePage | null>,
  random: () => number = Math.random
): Promise<string | null> {
  const probe = await fetchPage(1, PAGE_SIZE);
  if (!probe || probe.total <= 0) return null;
  const pages = Math.max(1, Math.ceil(probe.total / PAGE_SIZE));
  const page = 1 + Math.floor(random() * pages);
  const chosen = page === 1 ? probe : ((await fetchPage(page, PAGE_SIZE)) ?? probe);
  let pool = chosen.products.filter(buyable);
  if (pool.length === 0) pool = probe.products.filter(buyable);
  if (pool.length === 0) return null;
  return pool[Math.floor(random() * pool.length)].slug;
}
