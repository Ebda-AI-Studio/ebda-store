/**
 * Two-way adapter between the legacy layout blob (`stores.layout_settings`,
 * `StoreLayoutSettings`) and `PageDefinition` v1.
 *
 *   layoutToDefinition(resolvedLayout) -> PageDefinition
 *   definitionToLayout(definition)     -> StoreLayoutSettings (resolved shape)
 *
 * Guarantees (pinned by `adapter.test.ts` over the golden fixtures and a
 * generated corpus):
 *   1. definitionToLayout(layoutToDefinition(L)) deep-equals L for any
 *      resolved layout L (the storefront and admin read exactly what they
 *      read before).
 *   2. layoutToDefinition(definitionToLayout(D)) deep-equals D for any D the
 *      adapter produced.
 *
 * Mapping per section: the legacy section object becomes `settings`, minus
 *   - `enabled`           -> `hidden` (`enabled:false` <-> `hidden:true`; an
 *                            unset optional `enabled` stays unset, so the
 *                            store-flag fallback keeps working),
 *   - `hideOnMobile`      -> `responsive.mobile.hidden`,
 *   - `hideOnDesktop`     -> `responsive.desktop.hidden` (+ `tablet` when the
 *                            legacy two-way mode applies),
 *   - `hideOnTablet`      -> `responsive.tablet.hidden`,
 *   - `paddingTopTablet|Mobile`, `paddingBottomTablet|Mobile` (Ruling SP-1)
 *                         -> `responsive.<tablet|mobile>.settings.paddingTop|paddingBottom`,
 *   - categories `layoutMobile` / `captionPositionMobile`
 *                         -> `responsive.mobile.settings.layout` / `.captionPosition`,
 *   - hero `slides`       -> ordered `blocks` of type `slide` (ids `slide-1`…).
 * Everything else (including keys the adapter does not know) stays in
 * `settings` untouched, which is what makes the round trip lossless.
 * Announcement + header land in the `header` section group, footer in the
 * `footer` group; the eight body sections and product carousels are the
 * page template (`sections`).
 *
 * Known non-round-trips (documented, Ruling BUILDER-ADAPTER-1): a legacy
 * `hideOnTablet` explicitly equal to `hideOnDesktop` normalises away (it is
 * the legacy two-way mode either way), and a document whose required section
 * (hero, categories, carousels, testimonials) was removed projects as that
 * section disabled.
 */
import {
  DEFAULT_LAYOUT_SETTINGS,
  resolveLayoutSettings,
  type StoreLayoutSettings,
} from '../types/store-layout';
import type { TemplateId } from '../types/store-theme';
import { ALL_PAGE_OWNED_KEYS } from './page-settings';
import {
  LEGACY_HOME_SECTION_KEYS,
  resolveLegacySectionOrder,
  type LegacyHomeSectionKey,
} from './section-keys';
import {
  getSectionDefinition,
  legacySectionId,
  sectionDefinitionForLegacyKey,
  type LegacyLayoutKey,
} from './registry';
import {
  PAGE_DEFINITION_SCHEMA_VERSION,
  type PageDefinition,
  type BlockNode,
  type SectionNode,
  type ViewportOverride,
} from './schema';

type LegacyObject = Record<string, unknown>;

/** Mobile-only legacy prop names, per registry responsive prop. */
export const MOBILE_PROP_LEGACY_NAME: Record<string, Record<string, string>> = {
  categories: { layout: 'layoutMobile', captionPosition: 'captionPositionMobile' },
};

/**
 * Per-device spacing (Ruling SP-1), every section: the legacy object keeps flat
 * `paddingTopTablet` ... keys, the document keeps `responsive.<vp>.settings.paddingTop`.
 */
export const SPACING_VIEWPORT_LEGACY_NAME: Record<'tablet' | 'mobile', Record<string, string>> = {
  tablet: { paddingTop: 'paddingTopTablet', paddingBottom: 'paddingBottomTablet' },
  mobile: { paddingTop: 'paddingTopMobile', paddingBottom: 'paddingBottomMobile' },
};

const HEADER_GROUP: LegacyLayoutKey[] = ['announcement', 'header'];
const FOOTER_GROUP: LegacyLayoutKey[] = ['footer'];
const OPTIONAL_KEYS = new Set<string>([
  'brandStory',
  'blogCarousel',
  'trustStrip',
  'announcement',
  'header',
  'footer',
]);

/** Layout keys that are not sections; carried verbatim in `siteSettings`. */
export const SITE_SETTING_KEYS = [
  'filterSidebar',
  'reviewSection',
  'sizing',
  'productCardDefaults',
  'productsPage',
  'productDetailPage',
  'categoriesPage',
  'locationsPage',
  'checkoutPage',
  'cartPage',
  'bottomBar',
] as const satisfies ReadonlyArray<keyof StoreLayoutSettings>;

/** Legacy keys whose array entries become blocks: `<layoutKey>.<field>` -> block type. */
const BLOCK_FIELDS: Record<string, { field: string; blockType: string; idPrefix: string }> = {
  hero: { field: 'slides', blockType: 'slide', idPrefix: 'slide' },
  // Absent `items` stays absent (legacy fixed defaults); `[]` round-trips as no blocks.
  trustStrip: { field: 'items', blockType: 'item', idPrefix: 'item' },
};

function legacyToSection(
  id: string,
  type: string,
  legacyKey: string,
  src: LegacyObject
): SectionNode {
  const settings: LegacyObject = { ...src };
  const node: SectionNode = { id, type, settings };
  const blockField = BLOCK_FIELDS[legacyKey];
  if (blockField && Array.isArray(settings[blockField.field])) {
    node.blocks = (settings[blockField.field] as unknown[]).map(
      (b, i): BlockNode => ({
        id: `${blockField.idPrefix}-${i + 1}`,
        type: blockField.blockType,
        settings: { ...(b as LegacyObject) },
      })
    );
    delete settings[blockField.field];
  }
  if ('enabled' in settings) {
    if (settings.enabled !== undefined) node.hidden = settings.enabled === false;
    delete settings.enabled;
  }
  const responsive: {
    desktop?: ViewportOverride;
    tablet?: ViewportOverride;
    mobile?: ViewportOverride;
  } = {};
  const vp = (v: 'desktop' | 'tablet' | 'mobile'): ViewportOverride => (responsive[v] ??= {});
  if ('hideOnMobile' in settings) {
    if (settings.hideOnMobile !== undefined) vp('mobile').hidden = settings.hideOnMobile as boolean;
    delete settings.hideOnMobile;
  }
  const hasTablet = 'hideOnTablet' in settings && settings.hideOnTablet !== undefined;
  if ('hideOnDesktop' in settings) {
    if (settings.hideOnDesktop !== undefined) {
      vp('desktop').hidden = settings.hideOnDesktop as boolean;
      if (!hasTablet) vp('tablet').hidden = settings.hideOnDesktop as boolean;
    }
    delete settings.hideOnDesktop;
  }
  if ('hideOnTablet' in settings) {
    if (hasTablet) vp('tablet').hidden = settings.hideOnTablet as boolean;
    delete settings.hideOnTablet;
  }
  const mobileNames = MOBILE_PROP_LEGACY_NAME[legacyKey];
  if (mobileNames) {
    for (const [name, legacyName] of Object.entries(mobileNames)) {
      if (legacyName in settings) {
        if (settings[legacyName] !== undefined)
          (vp('mobile').settings ??= {})[name] = settings[legacyName];
        delete settings[legacyName];
      }
    }
  }
  for (const v of ['tablet', 'mobile'] as const) {
    for (const [name, legacyName] of Object.entries(SPACING_VIEWPORT_LEGACY_NAME[v])) {
      if (legacyName in settings) {
        if (settings[legacyName] !== undefined)
          (vp(v).settings ??= {})[name] = settings[legacyName];
        delete settings[legacyName];
      }
    }
  }
  if (Object.keys(responsive).length > 0) node.responsive = responsive;
  return node;
}

/** Rebuild the legacy section object a section node stands for. */
export function sectionToLegacy(node: SectionNode, legacyKey: string): LegacyObject {
  const out: LegacyObject = { ...node.settings };
  const blockField = BLOCK_FIELDS[legacyKey];
  if (blockField && node.blocks) {
    // A hidden block is not rendered: the legacy shape has no per-slide flag.
    out[blockField.field] = node.blocks
      .filter(b => b.type === blockField.blockType && b.hidden !== true)
      .map(b => ({ ...b.settings }));
  }
  if (node.hidden !== undefined) out.enabled = !node.hidden;
  const r = node.responsive;
  if (r?.mobile?.hidden !== undefined) out.hideOnMobile = r.mobile.hidden;
  const t = r?.tablet?.hidden;
  const d = r?.desktop?.hidden;
  if (t === d) {
    if (d !== undefined) out.hideOnDesktop = d;
  } else {
    out.hideOnTablet = t ?? false;
    if (d !== undefined) out.hideOnDesktop = d;
  }
  const mobileNames = MOBILE_PROP_LEGACY_NAME[legacyKey];
  if (mobileNames && r?.mobile?.settings) {
    for (const [name, legacyName] of Object.entries(mobileNames)) {
      if (r.mobile.settings[name] !== undefined) out[legacyName] = r.mobile.settings[name];
    }
  }
  for (const v of ['tablet', 'mobile'] as const) {
    for (const [name, legacyName] of Object.entries(SPACING_VIEWPORT_LEGACY_NAME[v])) {
      if (r?.[v]?.settings?.[name] !== undefined) out[legacyName] = r[v]!.settings![name];
    }
  }
  return out;
}

/** Deterministic, schema-valid section id for an extra carousel. */
function extraSectionId(rawId: unknown, taken: Set<string>): string {
  const slug =
    String(rawId ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'x';
  let id = `extra-${slug}`;
  for (let n = 2; taken.has(id); n++) id = `extra-${slug}-${n}`;
  taken.add(id);
  return id;
}

export function layoutToDefinition(layout: StoreLayoutSettings, pageKey = 'home'): PageDefinition {
  const L = layout as unknown as Record<string, unknown>;
  const absent: string[] = [];
  const taken = new Set<string>();
  const sections: SectionNode[] = [];
  const header: SectionNode[] = [];
  const footer: SectionNode[] = [];

  const fixed = (key: LegacyLayoutKey): SectionNode => {
    const d = sectionDefinitionForLegacyKey(key);
    const src = L[key];
    if (src === undefined) absent.push(key);
    const id = legacySectionId(key);
    taken.add(id);
    return legacyToSection(id, d.type, key, (src ?? {}) as LegacyObject);
  };

  for (const key of HEADER_GROUP) {
    if (L[key] !== undefined) header.push(fixed(key));
    else absent.push(key);
  }
  for (const key of resolveLegacySectionOrder(layout.sectionOrder)) sections.push(fixed(key));
  const extras = layout.extraCarousels;
  if (extras === undefined) absent.push('extraCarousels');
  for (const extra of extras ?? []) {
    const src = extra as unknown as LegacyObject;
    sections.push(
      legacyToSection(extraSectionId(src.id, taken), 'product-carousel', 'extraCarousels', src)
    );
  }
  for (const key of FOOTER_GROUP) {
    if (L[key] !== undefined) footer.push(fixed(key));
    else absent.push(key);
  }

  const siteSettings: Record<string, unknown> = {};
  for (const key of SITE_SETTING_KEYS) if (L[key] !== undefined) siteSettings[key] = L[key];

  const legacy: NonNullable<PageDefinition['legacy']> = {};
  if (layout.sectionOrder !== undefined) legacy.sectionOrder = [...layout.sectionOrder];
  if (absent.length > 0) legacy.absentSections = absent;

  return {
    schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
    pageKey,
    sectionGroups: { header, footer },
    sections,
    siteSettings,
    ...(Object.keys(legacy).length > 0 ? { legacy } : {}),
  };
}

function isEmptyNode(n: SectionNode): boolean {
  return (
    Object.keys(n.settings).length === 0 &&
    n.hidden === undefined &&
    !n.responsive &&
    n.blocks === undefined
  );
}

/** Every section of a document: header group, template, footer group (render order). */
export function allSections(def: PageDefinition): SectionNode[] {
  return [...def.sectionGroups.header, ...def.sections, ...def.sectionGroups.footer];
}

export function definitionToLayout(def: PageDefinition): StoreLayoutSettings {
  const out: Record<string, unknown> = {};
  const absent = new Set(def.legacy?.absentSections ?? []);
  const order: LegacyHomeSectionKey[] = [];
  const extras: LegacyObject[] = [];
  const seen = new Set<string>();

  for (const node of allSections(def)) {
    const d = getSectionDefinition(node.type);
    if (!d) continue; // unknown type: nothing to project (renderers skip it too)
    if (d.legacyKey === null) continue; // document-only type: lives in the document alone
    if (d.legacyKey === 'extraCarousels') {
      extras.push(sectionToLegacy(node, 'extraCarousels'));
      continue;
    }
    const key = d.legacyKey;
    if (seen.has(key)) continue; // cardinality 'one': first wins (validate rejects dupes)
    seen.add(key);
    if ((LEGACY_HOME_SECTION_KEYS as ReadonlyArray<string>).includes(key))
      order.push(key as LegacyHomeSectionKey);
    if (absent.has(key) && OPTIONAL_KEYS.has(key) && isEmptyNode(node)) continue;
    out[key] = sectionToLegacy(node, key);
  }

  // A required section the document dropped projects as disabled, never as
  // the packaged default (which would switch it back ON).
  const D = DEFAULT_LAYOUT_SETTINGS as unknown as Record<string, LegacyObject>;
  for (const key of LEGACY_HOME_SECTION_KEYS) {
    if (!seen.has(key) && !OPTIONAL_KEYS.has(key)) out[key] = { ...D[key], enabled: false };
  }

  if (extras.length > 0 || !absent.has('extraCarousels')) out.extraCarousels = extras;

  const savedOrder = def.legacy?.sectionOrder;
  const rendered = resolveLegacySectionOrder(order);
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((k, i) => k === b[i]);
  if (savedOrder !== undefined && same(resolveLegacySectionOrder(savedOrder), rendered)) {
    out.sectionOrder = savedOrder;
  } else if (savedOrder !== undefined || !same(rendered, LEGACY_HOME_SECTION_KEYS)) {
    out.sectionOrder = rendered;
  }

  for (const [k, v] of Object.entries(def.siteSettings)) out[k] = v;
  return resolveLayoutSettings(out);
}

/**
 * Does a PUBLISHED document still agree with `stores.layout_settings`?
 * `layout` is the row as the public route serves it: resolved against the
 * store's TEMPLATE baseline. Publish stores `definitionToLayout(def)` (JSONB:
 * `undefined` keys vanish), so the document side must go through the same
 * store + template resolve before comparing. Comparing the template-less
 * projection made every template family and every removed section look like
 * drift, and every store silently fell back to the layout-derived page
 * (Ruling BUILDER-PUBLISH-1). Only an out-of-band write to the row disagrees.
 */
export function publishedDocumentAgrees(
  def: PageDefinition,
  layout: StoreLayoutSettings,
  templateId: TemplateId | undefined,
  /** The store's look: resolve the document side the same way the layout was resolved. */
  look?: string | null
): boolean {
  const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  const served = resolveLayoutSettings(json(definitionToLayout(def)), templateId, look);
  // The keys a product / collection / cart document owns are written by that page's publish, so the
  // home document's copy of them may lag the live layout without the home page having drifted.
  const withoutOwned = (v: unknown): unknown => {
    const o = { ...(v as Record<string, unknown>) };
    for (const k of ALL_PAGE_OWNED_KEYS) delete o[k];
    return o;
  };
  return isDeepEqualJson(withoutOwned(json(served)), withoutOwned(json(layout)));
}

/** Structural equality of two JSON values (object key order ignored). */
function isDeepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => isDeepEqualJson(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every(
      k =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        isDeepEqualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  );
}

/**
 * A new, visible section built from a registry preset (the "Add section"
 * picker). `id` must be unique in the document; validate before saving.
 */
export function sectionFromPreset(type: string, presetIndex: number, id: string): SectionNode {
  const d = getSectionDefinition(type);
  const preset = d?.presets[presetIndex];
  if (!d || !preset) throw new Error(`no preset ${presetIndex} for section type ${type}`);
  const node = legacyToSection(id, type, d.legacyKey ?? '', { ...preset.settings });
  node.hidden = false;
  if (d.blocks.length > 0 || preset.blocks)
    node.blocks = (preset.blocks ?? []).map((b, i) => ({
      id: `${b.type}-${i + 1}`,
      type: b.type,
      settings: { ...b.settings },
    }));
  if (d.legacyKey === 'extraCarousels' && node.settings.id === undefined) node.settings.id = id;
  return node;
}

/** True for section types that exist only in the document (no `layout_settings` key). */
export function isDocumentOnlySection(node: SectionNode): boolean {
  return getSectionDefinition(node.type)?.legacyKey === null;
}

/**
 * Carry the DOCUMENT-ONLY sections of `previous` into `next` — a document
 * rebuilt from `layout_settings` (the legacy page-builder save, the legacy
 * layout PUT) knows nothing about them and would otherwise delete them.
 * Each one is re-inserted after the same predecessor id it had in
 * `previous` (or at the start when that predecessor is gone); ids already in
 * `next` win. Pure; returns a new document.
 */
export function mergeDocumentOnlySections(
  next: PageDefinition,
  previous: PageDefinition | null | undefined
): PageDefinition {
  if (!previous) return next;
  const sections = [...next.sections];
  const ids = new Set(sections.map(s => s.id));
  previous.sections.forEach((node, i) => {
    if (!isDocumentOnlySection(node) || ids.has(node.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = sections.findIndex(s => s.id === previous.sections[j].id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    sections.splice(at, 0, node);
    ids.add(node.id);
  });
  return { ...next, sections };
}
