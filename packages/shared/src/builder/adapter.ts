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
 * Mapping per section: the legacy section object becomes `props`, minus
 *   - `enabled`           -> `hidden` (`enabled:false` <-> `hidden:true`; an
 *                            unset optional `enabled` stays unset, so the
 *                            store-flag fallback keeps working),
 *   - `hideOnMobile`      -> `responsive.mobile.hidden`,
 *   - `hideOnDesktop`     -> `responsive.desktop.hidden` (+ `tablet` when the
 *                            legacy two-way mode applies),
 *   - `hideOnTablet`      -> `responsive.tablet.hidden`,
 *   - categories `layoutMobile` / `captionPositionMobile`
 *                         -> `responsive.mobile.props.layout` / `.captionPosition`.
 * Everything else (including keys the adapter does not know) stays in
 * `props` untouched, which is what makes the round trip lossless.
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
  type SectionNode,
  type ViewportOverride,
} from './schema';

type LegacyObject = Record<string, unknown>;

/** Mobile-only legacy prop names, per registry responsive prop. */
const MOBILE_PROP_LEGACY_NAME: Record<string, Record<string, string>> = {
  categories: { layout: 'layoutMobile', captionPosition: 'captionPositionMobile' },
};

const CHROME_TOP: LegacyLayoutKey[] = ['announcement', 'header'];
const CHROME_BOTTOM: LegacyLayoutKey[] = ['footer'];
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

function legacyToSection(
  id: string,
  type: string,
  legacyKey: string,
  src: LegacyObject
): SectionNode {
  const props: LegacyObject = { ...src };
  const node: SectionNode = { id, type, props };
  if ('enabled' in props) {
    if (props.enabled !== undefined) node.hidden = props.enabled === false;
    delete props.enabled;
  }
  const responsive: {
    desktop?: ViewportOverride;
    tablet?: ViewportOverride;
    mobile?: ViewportOverride;
  } = {};
  const vp = (v: 'desktop' | 'tablet' | 'mobile'): ViewportOverride => (responsive[v] ??= {});
  if ('hideOnMobile' in props) {
    if (props.hideOnMobile !== undefined) vp('mobile').hidden = props.hideOnMobile as boolean;
    delete props.hideOnMobile;
  }
  const hasTablet = 'hideOnTablet' in props && props.hideOnTablet !== undefined;
  if ('hideOnDesktop' in props) {
    if (props.hideOnDesktop !== undefined) {
      vp('desktop').hidden = props.hideOnDesktop as boolean;
      if (!hasTablet) vp('tablet').hidden = props.hideOnDesktop as boolean;
    }
    delete props.hideOnDesktop;
  }
  if ('hideOnTablet' in props) {
    if (hasTablet) vp('tablet').hidden = props.hideOnTablet as boolean;
    delete props.hideOnTablet;
  }
  const mobileNames = MOBILE_PROP_LEGACY_NAME[legacyKey];
  if (mobileNames) {
    for (const [prop, legacyName] of Object.entries(mobileNames)) {
      if (legacyName in props) {
        if (props[legacyName] !== undefined) (vp('mobile').props ??= {})[prop] = props[legacyName];
        delete props[legacyName];
      }
    }
  }
  if (Object.keys(responsive).length > 0) node.responsive = responsive;
  return node;
}

/** Rebuild the legacy section object a section node stands for. */
export function sectionToLegacy(node: SectionNode, legacyKey: string): LegacyObject {
  const out: LegacyObject = { ...node.props };
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
  if (mobileNames && r?.mobile?.props) {
    for (const [prop, legacyName] of Object.entries(mobileNames)) {
      if (r.mobile.props[prop] !== undefined) out[legacyName] = r.mobile.props[prop];
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

  const pushFixed = (key: LegacyLayoutKey) => {
    const d = sectionDefinitionForLegacyKey(key);
    const src = L[key];
    if (src === undefined) absent.push(key);
    const id = legacySectionId(key);
    taken.add(id);
    sections.push(legacyToSection(id, d.type, key, (src ?? {}) as LegacyObject));
  };

  for (const key of CHROME_TOP) if (L[key] !== undefined) pushFixed(key);
  for (const key of CHROME_TOP) if (L[key] === undefined) absent.push(key);
  for (const key of resolveLegacySectionOrder(layout.sectionOrder)) pushFixed(key);
  const extras = layout.extraCarousels;
  if (extras === undefined) absent.push('extraCarousels');
  for (const extra of extras ?? []) {
    const src = extra as unknown as LegacyObject;
    sections.push(
      legacyToSection(extraSectionId(src.id, taken), 'product-carousel', 'extraCarousels', src)
    );
  }
  for (const key of CHROME_BOTTOM) {
    if (L[key] !== undefined) pushFixed(key);
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
    sections,
    siteSettings,
    ...(Object.keys(legacy).length > 0 ? { legacy } : {}),
  };
}

function isEmptyNode(n: SectionNode): boolean {
  return Object.keys(n.props).length === 0 && n.hidden === undefined && !n.responsive;
}

export function definitionToLayout(def: PageDefinition): StoreLayoutSettings {
  const out: Record<string, unknown> = {};
  const absent = new Set(def.legacy?.absentSections ?? []);
  const order: LegacyHomeSectionKey[] = [];
  const extras: LegacyObject[] = [];
  const seen = new Set<string>();

  for (const node of def.sections) {
    const d = getSectionDefinition(node.type);
    if (!d) continue; // unknown type: nothing to project (renderers skip it too)
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
