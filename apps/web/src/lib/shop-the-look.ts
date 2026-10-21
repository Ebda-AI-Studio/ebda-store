import type { PageDefinition } from '@ebda/shared';

/**
 * One shop-the-look panel, as the "Shop this look" page reads it (W2a; Ahmad 2026-10-16, amends
 * Ruling B1-6). Found only in the store's OWN published home document (store-scoped by
 * construction: the caller fetched it for the resolved store), only when the section and the
 * `look` block are visible; product ids are returned in panel order, at most 4 (the block cap).
 */
export interface LookPanel {
  sectionId: string;
  blockId: string;
  title: string;
  titleAr: string;
  image: string;
  imageAr: string;
  alt: string;
  altAr: string;
  productIds: string[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** Ids are the builder's own node ids: short, URL-safe. Anything else is not a panel. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function findLookPanel(
  def: PageDefinition | undefined,
  sectionId: string,
  blockId: string
): LookPanel | null {
  if (!def || !SAFE_ID.test(sectionId) || !SAFE_ID.test(blockId)) return null;
  const section = def.sections.find(
    n => n.id === sectionId && n.type === 'shop-the-look' && n.hidden !== true
  );
  const block = section?.blocks?.find(b => b.id === blockId && b.type === 'look' && !b.hidden);
  if (!section || !block) return null;
  const s = block.settings as Record<string, unknown>;
  const ids = Array.isArray(s.productIds) ? s.productIds : [];
  const productIds = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ].slice(0, 4);
  if (productIds.length === 0) return null;
  return {
    sectionId,
    blockId,
    title: str(s.title),
    titleAr: str(s.titleAr),
    image: str(s.image),
    imageAr: str(s.imageAr),
    alt: str(s.alt),
    altAr: str(s.altAr),
    productIds,
  };
}

/** The panel page's path (relative; callers prefix the store URL). */
export function lookPanelPath(sectionId: string, blockId: string): string {
  return `/looks/${encodeURIComponent(sectionId)}/${encodeURIComponent(blockId)}`;
}
