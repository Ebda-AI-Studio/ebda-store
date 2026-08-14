import { DbClient, SlugEntityType, prisma } from '@force/database';

/**
 * Record a slug rename so the old URL 301s to the new one.
 * Call inside the same transaction as the entity write. Ordering matters:
 * reuse-guard, then chain-collapse, then upsert.
 */
export async function recordSlugRedirect(
  tx: DbClient,
  storeId: string,
  entityType: SlugEntityType,
  oldSlug: string,
  newSlug: string
): Promise<void> {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return;

  // 1. Reuse guard — the new slug is live again, it must never redirect.
  await tx.slugRedirect.deleteMany({ where: { storeId, entityType, fromSlug: newSlug } });

  // 2. Chain-collapse — any redirect pointing at the old slug now points at the new one.
  await tx.slugRedirect.updateMany({
    where: { storeId, entityType, toSlug: oldSlug },
    data: { toSlug: newSlug },
  });

  // 3. Upsert old -> new.
  await tx.slugRedirect.upsert({
    where: { storeId_entityType_fromSlug: { storeId, entityType, fromSlug: oldSlug } },
    create: { storeId, entityType, fromSlug: oldSlug, toSlug: newSlug },
    update: { toSlug: newSlug },
  });
}

/**
 * Resolve a (possibly stale) slug to its current one, following the
 * SlugRedirect chain. recordSlugRedirect keeps chains collapsed to a single
 * hop, so the 3-hop cap here is purely a defensive backstop for legacy rows
 * or a self-loop, not the expected path.
 *
 * NOTE: the hop cap alone does not prevent a 2-cycle (A→B, B→A); convergence
 * instead relies on recordSlugRedirect being the sole writer — its
 * reuse-guard + chain-collapse steps prevent inverse rows from coexisting.
 *
 * Returns null when the slug was never redirected (first lookup misses);
 * otherwise the final resolved slug.
 */
export async function resolveSlugRedirect(
  storeId: string,
  entityType: SlugEntityType,
  slug: string
): Promise<string | null> {
  let current = slug;
  for (let hops = 0; hops < 3; hops++) {
    const row = await prisma.slugRedirect.findUnique({
      where: { storeId_entityType_fromSlug: { storeId, entityType, fromSlug: current } },
    });
    if (!row) return current === slug ? null : current;
    if (row.toSlug === current) return current; // self-loop guard
    current = row.toSlug;
  }
  return current;
}
