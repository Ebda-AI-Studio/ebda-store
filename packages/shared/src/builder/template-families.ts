/**
 * The five storefront template FAMILIES (page presets) the builder will
 * offer (template shortlist, docs/plans/done/2026-10-07-builder-template-shortlist.md).
 * Final names: Ahmad, 2026-10-07. Phase 1 declares them only (ids, bilingual
 * labels, which registry sections each one composes); the presets themselves
 * are built and visually evaluated in Phase 2 against the shortlist rubric.
 *
 * These are page-composition presets, distinct from the component skins
 * (`TemplateId`), although each family now names the skin it renders on.
 */
import type { BlockNode, PageDefinition, SectionNode } from './schema';
import type { TemplateId } from '../types/store-theme';
import { getSectionDefinition } from './registry';
import { layoutToDefinition, sectionFromPreset } from './adapter';
import { resolveLayoutSettings } from '../types/store-layout';
import { TEMPLATE_LAYOUT_BASELINES } from '../types/template-baselines';
import { getLook } from '../looks/registry';
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
      'spec-sheet', // T7 signature section
      'footer',
    ],
    pendingSectionTypes: [],
    // Phase B2 (Ruling B2-1): Souq has its own chrome skin; the looks decide the mixes.
    skin: 'souq',
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
      // Phase B5 (Rulings B5-7, B5-8): the gift finder is new; the journey strip reuses Jasmine's `steps`.
      'gift-finder',
      'steps',
      'category-grid',
      'product-carousel',
      'brand-story',
      'piece-window', // T7 signature section
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
      'editorial-collage', // T7 signature section
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
      'maker-profile',
      'product-carousel',
      'featured-collection',
      'category-grid',
      'trust-strip',
      'blog-carousel',
      'kitchen-days', // T7 signature section
      'footer',
    ],
    pendingSectionTypes: [],
    // Phase B4 (Ruling B4-1): Lamma has its own chrome skin; the looks decide the mixes.
    skin: 'lamma',
  },
  {
    id: 'jasmine',
    labelEn: 'Jasmine',
    labelAr: 'ياسمين',
    verticalEn: 'Beauty and skincare',
    verticalAr: 'جمال وعناية بالبشرة',
    sectionTypes: [
      'hero',
      'category-grid',
      'steps',
      'product-carousel',
      'featured-collection',
      'product-spotlight',
      'trust-strip',
      'image-text',
      'testimonials',
      'newsletter',
      'key-ingredients', // T7 signature section
      'footer',
    ],
    pendingSectionTypes: [],
    // Phase B3 (Ruling B3-1): Jasmine has its own chrome skin; the looks decide the mixes.
    skin: 'jasmine',
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
  // ids of sections created in THIS application (never deduplicated against each other)
  const fresh = new Set<string>();
  for (const spec of specs) {
    const d = getSectionDefinition(spec.type);
    if (!d || d.group !== 'template') continue; // header/footer stay as the store has them
    const incoming = spec.design ?? {};
    // A mix may name a type more than once (Souq: two carousels, three stages). The nth spec of a
    // type pairs with the nth outgoing spec of that type and with the nth existing section; the
    // LAST spec of the type takes every section left over, so a mix with one spec per type
    // behaves exactly as before.
    const sameType = specs.filter(x => x.type === spec.type);
    const nth = sameType.indexOf(spec);
    const outgoing = opts.from?.sections?.filter(o => o.type === spec.type)[nth]?.design ?? {};
    const all = pool.filter(n => n.type === spec.type);
    // The last spec takes every section left over, EXCEPT a surplus section the outgoing look
    // itself seeded (the outgoing mix had a spec for it that this mix has no spec for): that one
    // leaves the draft unless `keep` finds the merchant edited it. Sections beyond the outgoing
    // look's specs are the merchant's own and always stay (a store's extra carousels).
    const outSpecs = opts.from?.sections?.filter(o => o.type === spec.type) ?? [];
    const origIndex = (n: SectionNode) => source.sections.filter(x => x.type === n.type).indexOf(n);
    let existing =
      nth === sameType.length - 1
        ? all.filter((n, i) => {
            const idx = nth + i;
            if (i === 0 || idx >= outSpecs.length) return true;
            // a merchant-EDITED surplus section always stays (reset is design-only, like keep)
            return editedSinceLook(n, opts, idx);
          })
        : all.slice(0, 1);
    // When either mix repeats this type, "the nth section" is a position, not an identity: an
    // UNTOUCHED section the outgoing look seeded (still its preset) would be re-labelled as the
    // incoming look's nth section and keep the OLD preset (Night's curated carousel posing as
    // Catalogue's deals row). Such a section is replaced by a fresh one from the incoming preset;
    // an edited one stays and takes the incoming design. Single-spec types are untouched by this.
    if ((sameType.length > 1 || outSpecs.length > 1) && opts.from) {
      const stale = existing.filter(n => !editedSinceLook(n, opts, origIndex(n)));
      for (const n of stale) pool.splice(pool.indexOf(n), 1);
      existing = existing.filter(n => !stale.includes(n));
    }
    if (existing.length === 0) {
      // A section the switch already carried over with the SAME product source as this spec's
      // preset (an edited deals carousel that took another slot by position) is not added twice.
      const src = (spec.preset as { productSource?: unknown } | undefined)?.productSource;
      if (
        src !== undefined &&
        src !== 'manual' && // hand-picked / category rows legitimately repeat
        src !== 'category' &&
        doc.sections.some(
          x => !fresh.has(x.id) && x.type === spec.type && x.settings.productSource === src
        )
      )
        continue;
      const freshNode = sectionFromPreset(spec.type, 0, uniqueSectionId(doc, spec.type));
      freshNode.settings = { ...freshNode.settings, ...(spec.preset ?? {}), ...incoming };
      if (spec.blocks) freshNode.blocks = specBlocks(spec.blocks);
      fresh.add(freshNode.id);
      doc = { ...doc, sections: [...doc.sections, freshNode] };
      continue;
    }
    for (const n of existing) {
      const settings = applySectionDesign(spec.type, n.settings, incoming, outgoing, opts);
      const shown = { ...n, hidden: false, settings };
      doc = { ...doc, sections: [...doc.sections, shown] };
      pool.splice(pool.indexOf(n), 1);
    }
  }
  // Ruling B1-45 (C8, TPL-1): on a look SWITCH with `keep`, a section the incoming mix does not use
  // stays on the draft (after the mix, in its order) when the merchant edited it; an untouched
  // section the outgoing look added leaves the draft (it stays in revision history).
  if (opts.design === 'keep' && opts.from) {
    // A kept section takes the incoming look's design: the keys only the outgoing look set
    // return to the default (C6), and a design key the merchant changed stays (C8).
    const kept = pool
      .filter(
        n =>
          getSectionDefinition(n.type)?.group === 'template' &&
          editedSinceLook(n, opts, source.sections.filter(x => x.type === n.type).indexOf(n))
      )
      .map(n => {
        const nth = source.sections.filter(x => x.type === n.type).indexOf(n);
        const outgoing = opts.from?.sections?.filter(o => o.type === n.type)[nth]?.design ?? {};
        return { ...n, settings: applySectionDesign(n.type, n.settings, {}, outgoing, opts) };
      });
    if (kept.length) doc = { ...doc, sections: [...doc.sections, ...kept] };
  }
  return look?.id && getLook(look.id) ? withoutSkinCardRatio(doc, opts) : doc;
}

const CARD_RATIO_KEYS = ['cardShape', 'cardAspect'] as const;
const RATIO_SECTIONS: Record<string, 'newArrivals' | 'bestSellers'> = {
  'new-arrivals': 'newArrivals',
  'best-sellers': 'bestSellers',
};

/**
 * Ruling LOOKS-15 at the document level (W2b, L-02): a registered look owns the default product
 * card ratio. A document composed on a skin before the look (a store that published its home
 * first, then took a look) holds that skin's baseline `cardShape`/`cardAspect` in its card
 * defaults and product carousels, which would beat the look's `--image-ratio` on every card.
 * `reset` drops them all (the look's design applies whole); `keep` drops only a value equal to
 * the outgoing skin's baseline, so a merchant's own pick stays.
 */
function withoutSkinCardRatio(doc: PageDefinition, opts: ApplyLookOptions): PageDefinition {
  const base = opts.fromSkin ? TEMPLATE_LAYOUT_BASELINES[opts.fromSkin.skin] : undefined;
  const drop = (
    settings: Record<string, unknown> | undefined,
    baseline: Record<string, unknown> | undefined
  ) => {
    if (!settings) return settings;
    const out = { ...settings };
    for (const k of CARD_RATIO_KEYS) {
      if (out[k] === undefined) continue;
      if (opts.design !== 'keep' || (baseline && out[k] === baseline[k])) delete out[k];
    }
    return out;
  };
  const sections = doc.sections.map(n => {
    const key = RATIO_SECTIONS[n.type];
    if (!key) return n;
    return {
      ...n,
      settings: drop(n.settings, base?.[key] as unknown as Record<string, unknown>) ?? {},
    };
  });
  const defaults = doc.siteSettings?.productCardDefaults as Record<string, unknown> | undefined;
  return {
    ...doc,
    sections,
    ...(defaults
      ? {
          siteSettings: {
            ...doc.siteSettings,
            productCardDefaults: drop(
              defaults,
              base?.productCardDefaults as Record<string, unknown> | undefined
            ) as typeof doc.siteSettings.productCardDefaults,
          },
        }
      : {}),
  };
}

/**
 * Whether a section holds anything beyond what the outgoing look (or the skin baseline) gave it:
 * a changed setting, or blocks other than its preset's.
 */
function editedSinceLook(n: SectionNode, opts: ApplyLookOptions, nth = 0): boolean {
  const spec = opts.from?.sections?.filter(o => o.type === n.type)[nth];
  const design = spec?.design ?? {};
  const preset = sectionFromPreset(n.type, 0, n.id);
  const seeds = [
    { ...preset.settings, ...(spec?.preset ?? {}), ...design },
    { ...sectionDefaults(n.type, opts.fromSkin ?? opts.toSkin), ...design },
  ];
  const untouched = (seed: Record<string, unknown>) =>
    [...new Set([...Object.keys(seed), ...Object.keys(n.settings)])].every(k =>
      sameValue(n.settings[k], seed[k])
    );
  if (!seeds.some(untouched)) return true;
  // The baseline blocks are the outgoing mix's own (Ruling B5-8) when it named some, else the preset's.
  const baseline = spec?.blocks
    ? specBlocks(spec.blocks)
    : (preset.blocks ?? []).map(b => ({ ...b }));
  return !sameValue(n.blocks ?? [], baseline);
}

/** Blocks a look spec seeds, with the ids `sectionFromPreset` gives preset blocks. */
function specBlocks(blocks: NonNullable<LookSectionSpec['blocks']>): BlockNode[] {
  return blocks.map((b, i) => ({
    id: `${b.type}-${i + 1}`,
    type: b.type,
    settings: { ...b.settings },
  }));
}
