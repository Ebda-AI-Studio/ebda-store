/**
 * The document a store has for a page kind before anyone edits it (Ruling VE-3). It lists the page's
 * sections in the order the storefront already renders them, so a store with no saved document renders
 * exactly what it rendered before page documents existed: nothing is migrated, and a document that is
 * never saved costs nothing.
 *
 * Section ids are the section types (each of these types appears once on its page), so a default
 * document is stable across reads and across stores.
 */
import { sectionFromPreset } from './adapter';
import { PAGE_DEFINITION_SCHEMA_VERSION, type PageDefinition } from './schema';
import { MAIN_SECTION_TYPE, type SectionPageKind } from './page-kinds';

/** Section types in storefront order, per kind. The pinned main comes first or in its real place. */
export const DEFAULT_PAGE_SECTIONS: Record<SectionPageKind, readonly string[]> = {
  // main, FAQ, reviews, frequently bought together, you might also like, related products
  product: [
    'product-main',
    'product-faq',
    'product-reviews',
    'product-bundles',
    'product-recommendations',
    'product-related',
  ],
  collection: ['collection-main'],
  // the cart lines and summary, then the recommendations under them
  cart: ['cart-main', 'cart-recommendations'],
};

export function defaultPageDocument(kind: SectionPageKind): PageDefinition {
  return {
    schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
    pageKey: kind,
    sectionGroups: { header: [], footer: [] },
    sections: DEFAULT_PAGE_SECTIONS[kind].map(type => sectionFromPreset(type, 0, type)),
    siteSettings: {},
  };
}

/** The pinned main section of a (non-home) page document, or undefined when it has none. */
export function mainSectionOf(doc: PageDefinition) {
  const kind = doc.pageKey as SectionPageKind;
  const type = MAIN_SECTION_TYPE[kind];
  return type ? doc.sections.find(n => n.type === type) : undefined;
}
