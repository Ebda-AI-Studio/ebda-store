import { documentForLook, getLook, pageDefinitionSchema, type PageDefinition } from '@ebda/shared';
import { API_URL, type Product } from '../../../../lib/api';
import type { ResolvedStore } from '../../../../lib/store-resolver';
import { demoHomeDefinition } from '../../../../lib/demo-home';
import { findLookPanel, type LookPanel } from '../../../../lib/shop-the-look';

/**
 * "Shop this look" (W2a; Ahmad 2026-10-16, amends Ruling B1-6): one shop-the-look panel's pieces
 * side by side, each with its own size choice and its own add, because every garment needs a
 * size (there is no one-tap "add the whole look"). Store-scoped twice: the panel is read from
 * the resolved store's own published home document, and the pieces are fetched with the store's
 * headers, so another store's id never resolves. A hidden or missing panel is a 404.
 */
export async function loadPanel(
  store: ResolvedStore,
  sectionId: string,
  blockId: string
): Promise<{ panel: LookPanel; pieces: Product[] } | null> {
  if (!store.id || store.id === 'demo') return null;
  const storeHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Store-ID': store.id,
    ...(store.domain ? { 'x-store-domain': store.domain } : {}),
  };
  const layout = await fetch(`${API_URL}/public/stores/${store.id}/layout`, {
    next: { revalidate: 60, tags: [`layout:${store.id}`] },
  })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  const parsed = pageDefinitionSchema.safeParse(layout?.data?.definition);
  const stored: PageDefinition | undefined = parsed.success ? parsed.data : undefined;
  // The same document the home renders: the demo's look mix, then the look's tagged sections.
  const mixed = demoHomeDefinition(store, stored);
  const def = mixed ? documentForLook(mixed, getLook(store.look)) : undefined;
  const panel = findLookPanel(def, sectionId, blockId);
  if (!panel) return null;
  const list = await fetch(
    `${API_URL}/public/products?ids=${encodeURIComponent(panel.productIds.join(','))}&limit=4`,
    { next: { revalidate: 60, tags: [`products:${store.id}`] }, headers: storeHeaders }
  )
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  const found: Product[] = list?.data?.products ?? [];
  // The list payload has no per-variant option map; the size choice needs the full product.
  const full = await Promise.all(
    panel.productIds
      .map(id => found.find(p => p.id === id))
      .filter((p): p is Product => !!p)
      .map(p =>
        fetch(`${API_URL}/public/products/${encodeURIComponent(p.slug)}`, {
          next: { revalidate: 60, tags: [`products:${store.id}`] },
          headers: storeHeaders,
        })
          .then(r => (r.ok ? r.json() : null))
          .then(j => (j?.data?.product as Product | undefined) ?? null)
          .catch(() => null)
      )
  );
  const pieces = full.filter((p): p is Product => !!p);
  return pieces.length ? { panel, pieces } : null;
}
