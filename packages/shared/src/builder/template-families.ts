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
import type { PageDefinition } from './schema';
import type { TemplateId } from '../types/store-theme';
import { getSectionDefinition } from './registry';
import { sectionFromPreset } from './adapter';
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

/** How a look switch treats a section's design fields (TPL-1, plan amendments C6/C8). */
export interface ApplyLookOptions {
  /** The look the store is switching FROM: the design keys its mix set are look-owned on this store. */
  from?: Pick<LookDefinition, 'sections'> | null;
  /**
   * `keep`: a design field the merchant changed from what `from` set (or, for a key `from` does
   * not set, from the section default) is left as the merchant has it. `reset` (default): the
   * incoming look's design applies and every key only `from` set returns to the section default.
   */
  design?: 'keep' | 'reset';
}

const defaultSettingsCache = new Map<string, Record<string, unknown>>();
/** A section type's default settings: its first registry preset. */
function sectionDefaults(type: string): Record<string, unknown> {
  let d = defaultSettingsCache.get(type);
  if (!d) {
    d = sectionFromPreset(type, 0, type).settings;
    defaultSettingsCache.set(type, d);
  }
  return d;
}

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
  mode: 'keep' | 'reset'
): Record<string, unknown> {
  const defaults = sectionDefaults(type);
  const next = { ...settings };
  for (const k of new Set([...Object.keys(outgoing), ...Object.keys(incoming)])) {
    if (mode === 'keep') {
      const baseline = k in outgoing ? outgoing[k] : defaults[k];
      if (!sameValue(settings[k] ?? defaults[k], baseline)) continue; // the merchant's own choice
    }
    if (k in incoming) next[k] = incoming[k];
    else if (defaults[k] === undefined) delete next[k];
    else next[k] = defaults[k];
  }
  return next;
}

/**
 * Compose a DRAFT document for a template family (Phase 2 preset picker), or for a look
 * (Ruling B1-3) when `look` carries a section mix.
 * Keeps everything that is the store's data rather than the layout: the
 * header/footer groups, site settings, and any existing section of a type
 * the family (or look) uses (so the merchant's hero slides, carousel choices and copy
 * survive). Types it adds come from their first registry preset plus the look's `preset`.
 * A look's `design` keys also apply to existing sections (see `ApplyLookOptions`).
 * Never publishes: the caller saves it as a draft.
 */
export function applyTemplateFamily(
  current: PageDefinition,
  familyId: TemplateFamily['id'],
  look?: Pick<LookDefinition, 'sections'> | null,
  opts: ApplyLookOptions = {}
): PageDefinition {
  const family = TEMPLATE_FAMILIES.find(f => f.id === familyId);
  if (!family) throw new Error(`unknown template family ${familyId}`);
  const specs: readonly LookSectionSpec[] =
    look?.sections && look.sections.length > 0
      ? look.sections
      : family.sectionTypes.map(type => ({ type }));
  const mode = opts.design ?? 'reset';
  let doc: PageDefinition = { ...current, sections: [] };
  const pool = [...current.sections];
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
      const settings = applySectionDesign(spec.type, n.settings, incoming, outgoing, mode);
      const shown = { ...n, hidden: false, settings };
      doc = { ...doc, sections: [...doc.sections, shown] };
      pool.splice(pool.indexOf(n), 1);
    }
  }
  return doc;
}
