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
import { getSectionDefinition } from './registry';
import { sectionFromPreset } from './adapter';
import { uniqueSectionId } from './editor/document-reducer';

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
    sectionTypes: [
      'header',
      'hero',
      'product-carousel',
      'image-text',
      'brand-story',
      'testimonials',
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

/**
 * Compose a DRAFT document for a template family (Phase 2 preset picker).
 * Keeps everything that is the store's data rather than the layout: the
 * header/footer groups, site settings, and any existing section of a type
 * the family uses (so the merchant's hero slides, carousel choices and copy
 * survive). Types the family adds come from their first registry preset.
 * Never publishes: the caller saves it as a draft.
 */
export function applyTemplateFamily(
  current: PageDefinition,
  familyId: TemplateFamily['id']
): PageDefinition {
  const family = TEMPLATE_FAMILIES.find(f => f.id === familyId);
  if (!family) throw new Error(`unknown template family ${familyId}`);
  let doc: PageDefinition = { ...current, sections: [] };
  const pool = [...current.sections];
  for (const type of family.sectionTypes) {
    const d = getSectionDefinition(type);
    if (!d || d.group !== 'template') continue; // header/footer stay as the store has them
    const existing = pool.filter(n => n.type === type);
    const take: SectionNode[] = existing.length > 0 ? existing : [];
    if (take.length === 0) {
      take.push(sectionFromPreset(type, 0, uniqueSectionId(doc, type)));
    }
    for (const n of take) {
      const shown = { ...n, hidden: false };
      doc = { ...doc, sections: [...doc.sections, shown] };
      pool.splice(pool.indexOf(n), 1);
    }
  }
  return doc;
}
