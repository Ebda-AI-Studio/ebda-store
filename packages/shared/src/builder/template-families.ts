/**
 * The five storefront template FAMILIES (page presets) the builder will
 * offer (template shortlist, docs/plans/2026-10-07-builder-template-shortlist.md).
 * Final names: Ahmad, 2026-10-07. Phase 1 declares them only (ids, bilingual
 * labels, which registry sections each one composes); the presets themselves
 * are built and visually evaluated in Phase 2 against the shortlist rubric.
 *
 * These are page-composition presets, distinct from the five legacy component
 * skins (`TemplateId`: modern/elegant/classic/minimal/bold).
 */
import type { PageDefinition, SectionNode } from './schema';
import type { TemplateId } from '../types/store-theme';
import { getSectionDefinition } from './registry';
import { layoutToDefinition, sectionFromPreset } from './adapter';
import { resolveLayoutSettings } from '../types/store-layout';
import { uniqueSectionId } from './editor/document-reducer';
import type { LookDefinition, LookSectionSpec } from '../looks/types';

export interface TemplateFamily {
  id: 'souq' | 'dahab' | 'qamar' | 'lamma' | 'jasmine';
  labelEn: string;
  labelAr: string;
  verticalEn: string;
  verticalAr: string;
  /** Registry section types the family composes, in page order. */
  sectionTypes: readonly string[];
  /** Section types it needs that are not in the registry yet (empty since Phase 2). */
  pendingSectionTypes: readonly string[];
  /** The component skin (`stores.template`) built for this family, when it has its own. */
  skin?: TemplateId;
}

export const TEMPLATE_FAMILIES: readonly TemplateFamily[] = [
  {
    id: 'souq',
    labelEn: 'Souq',
    labelAr: 'سوق',
    verticalEn: 'General retail and electronics',
    verticalAr: 'متجر عام وإلكترونيات',
    sectionTypes: [
      'announcement',
      'header',
      'hero',
      'category-grid',
      'product-carousel',
      'trust-strip',
      'testimonials',
      'newsletter',
      'footer',
    ],
    pendingSectionTypes: [],
  },
  {
    id: 'dahab',
    labelEn: 'Dahab',
    labelAr: 'دهب',
    verticalEn: 'Jewellery and handmade',
    verticalAr: 'مجوهرات ومشغولات يدوية',
    // Phase 3 pilot (2026-10-07): the first family built to completion, with
    // its own component skin (`TemplateId` 'dahab') and theme defaults
    // (`TEMPLATE_THEMES.dahab`). docs/ebda/templates/dahab.md.
    skin: 'dahab',
    sectionTypes: [
      'announcement',
      'header',
      'hero',
      'collection-list',
      'featured-collection',
      'image-text',
      'product-spotlight',
      'testimonials',
      'trust-badges',
      'newsletter',
      'footer',
    ],
    pendingSectionTypes: [],
  },
  {
    id: 'qamar',
    labelEn: 'Qamar',
    labelAr: 'قمر',
    verticalEn: 'Fashion and boutiques',
    verticalAr: 'أزياء وبوتيكات',
    sectionTypes: [
      'header',
      'hero',
      'category-grid',
      'product-carousel',
      'image-text',
      'brand-story',
      'testimonials',
      'footer',
    ],
    pendingSectionTypes: [],
  },
  {
    id: 'lamma',
    labelEn: 'Lamma',
    labelAr: 'لمّة',
    verticalEn: 'Food and home kitchens',
    verticalAr: 'أكل ومطبخ بيتي',
    sectionTypes: [
      'announcement',
      'header',
      'hero',
      'product-carousel',
      'category-grid',
      'trust-strip',
      'blog-carousel',
      'footer',
    ],
    pendingSectionTypes: [],
  },
  {
    id: 'jasmine',
    labelEn: 'Jasmine',
    labelAr: 'ياسمين',
    verticalEn: 'Beauty and skincare',
    verticalAr: 'جمال وعناية بالبشرة',
    sectionTypes: [
      'hero',
      'product-carousel',
      'trust-strip',
      'image-text',
      'testimonials',
      'newsletter',
      'footer',
    ],
    pendingSectionTypes: [],
  },
];

/** A skin + look pair whose layout baseline gives a layout-backed section its default settings. */
export interface SkinBaseline {
  skin: TemplateId;
  look?: string | null;
}

/** How a look switch treats a section's design fields (TPL-1, plan amendments C6/C8). */
export interface ApplyLookOptions {
  /** The look the store is switching FROM: the design keys its mix set are look-owned on this store. */
  from?: Pick<LookDefinition, 'sections'> | null;
  /**
   * `keep`: a design field the merchant changed from what `from` set (or, for a key `from` does
   * not set, from the outgoing default) is left as the merchant has it. `reset` (default): the
   * incoming look's design applies and every key only `from` set returns to the incoming default.
   */
  design?: 'keep' | 'reset';
  /** Outgoing skin baseline: the "untouched" value of a layout-backed section's key in `keep`. */
  fromSkin?: SkinBaseline;
  /** Incoming skin baseline: what a layout-backed section's look-owned key resets to. */
  toSkin?: SkinBaseline;
}

const baselineCache = new Map<string, Map<string, Record<string, unknown>>>();
/** Per section type, the settings a store with no layout edits holds on this skin + look. */
function skinBaseline(b: SkinBaseline): Map<string, Record<string, unknown>> {
  const cacheKey = `${b.skin}|${b.look ?? ''}`;
  let m = baselineCache.get(cacheKey);
  if (!m) {
    m = new Map();
    const doc = layoutToDefinition(resolveLayoutSettings({}, b.skin, b.look ?? null));
    for (const n of doc.sections) if (!m.has(n.type)) m.set(n.type, n.settings);
    baselineCache.set(cacheKey, m);
  }
  return m;
}

const presetCache = new Map<string, Record<string, unknown>>();
/**
 * A section type's default settings. A layout-backed type (hero, categories, testimonials, ...)
 * defaults to what the skin's own layout baseline holds, because that is what a page built from
 * `layout_settings` carries; a page-only type, a product carousel, or a call with no baseline
 * falls back to its first registry preset.
 */
function sectionDefaults(type: string, baseline?: SkinBaseline): Record<string, unknown> {
  const d = getSectionDefinition(type);
  if (baseline && d?.legacyKey && d.legacyKey !== 'extraCarousels') {
    const fromSkin = skinBaseline(baseline).get(type);
    if (fromSkin) return fromSkin;
  }
  let p = presetCache.get(type);
  if (!p) {
    p = sectionFromPreset(type, 0, type).settings;
    presetCache.set(type, p);
  }
  return p;
}

// Look design values are scalars today; JSON equality is enough and key order cannot differ.
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply the incoming look's design keys to an existing section's settings, resetting the keys
 * only the outgoing look set (C6) and, with `keep`, leaving every field the merchant changed (C8).
 * Content keys are never in a look's design (LOOK_DESIGN_KEYS), so they are never touched.
 */
function applySectionDesign(
  type: string,
  settings: Record<string, unknown>,
  incoming: Record<string, unknown>,
  outgoing: Record<string, unknown>,
  opts: ApplyLookOptions
): Record<string, unknown> {
  const before = sectionDefaults(type, opts.fromSkin ?? opts.toSkin);
  const after = sectionDefaults(type, opts.toSkin ?? opts.fromSkin);
  const next = { ...settings };
  for (const k of new Set([...Object.keys(outgoing), ...Object.keys(incoming)])) {
    if (opts.design === 'keep') {
      const baseline = k in outgoing ? outgoing[k] : before[k];
      if (!sameValue(settings[k] ?? before[k], baseline)) continue; // the merchant's own choice
    }
    if (k in incoming) next[k] = incoming[k];
    else if (after[k] === undefined) delete next[k];
    else next[k] = after[k];
  }
  return next;
}

/**
 * The document as it renders under `look`: when the look has a section mix, a section tagged
 * for another look (`lookTag`) is left out; untagged sections always stay. A look with no mix
 * (or no look) returns the document unchanged.
 */
export function documentForLook(
  def: PageDefinition,
  look: (Pick<LookDefinition, 'sections'> & { id?: string }) | null | undefined
): PageDefinition {
  if (!look?.sections || look.sections.length === 0) return def;
  const keep = (n: SectionNode) => n.lookTag === undefined || n.lookTag === look.id;
  if (def.sections.every(keep)) return def;
  return { ...def, sections: def.sections.filter(keep) };
}

/**
 * Compose a DRAFT document for a template family (Phase 2 preset picker), or for a look
 * (Ruling B1-3) when `look` carries a section mix.
 * Keeps everything that is the store's data rather than the layout: the
 * header/footer groups, site settings, and any existing section of a type
 * the family (or look) uses (so the merchant's hero slides, carousel choices and copy
 * survive). Types it adds come from their first registry preset plus the look's `preset`.
 * A look's `design` keys also apply to existing sections (see `ApplyLookOptions`); sections
 * tagged for another look are left out (`documentForLook`).
 * Never publishes: the caller saves it as a draft.
 */
export function applyTemplateFamily(
  current: PageDefinition,
  familyId: TemplateFamily['id'],
  look?: (Pick<LookDefinition, 'sections'> & { id?: string }) | null,
  opts: ApplyLookOptions = {}
): PageDefinition {
  const family = TEMPLATE_FAMILIES.find(f => f.id === familyId);
  if (!family) throw new Error(`unknown template family ${familyId}`);
  const specs: readonly LookSectionSpec[] =
    look?.sections && look.sections.length > 0
      ? look.sections
      : family.sectionTypes.map(type => ({ type }));
  const source = documentForLook(current, look);
  let doc: PageDefinition = { ...source, sections: [] };
  const pool = [...source.sections];
  for (const spec of specs) {
    const d = getSectionDefinition(spec.type);
    if (!d || d.group !== 'template') continue; // header/footer stay as the store has them
    const incoming = spec.design ?? {};
    const outgoing = opts.from?.sections?.find(o => o.type === spec.type)?.design ?? {};
    const existing = pool.filter(n => n.type === spec.type);
    if (existing.length === 0) {
      const fresh = sectionFromPreset(spec.type, 0, uniqueSectionId(doc, spec.type));
      fresh.settings = { ...fresh.settings, ...(spec.preset ?? {}), ...incoming };
      doc = { ...doc, sections: [...doc.sections, fresh] };
      continue;
    }
    for (const n of existing) {
      const settings = applySectionDesign(spec.type, n.settings, incoming, outgoing, opts);
      const shown = { ...n, hidden: false, settings };
      doc = { ...doc, sections: [...doc.sections, shown] };
      pool.splice(pool.indexOf(n), 1);
    }
  }
  return doc;
}
