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
export interface TemplateFamily {
  id: 'souq' | 'dahab' | 'qamar' | 'lamma' | 'jasmine';
  labelEn: string;
  labelAr: string;
  verticalEn: string;
  verticalAr: string;
  /** Registry section types the family composes today. */
  sectionTypes: readonly string[];
  /** Section types it needs that are not in the registry yet (new renderers, later phases). */
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
      'footer',
    ],
    pendingSectionTypes: ['newsletter'],
  },
  {
    id: 'dahab',
    labelEn: 'Dahab',
    labelAr: 'دهب',
    verticalEn: 'Jewellery and handmade',
    verticalAr: 'مجوهرات ومشغولات يدوية',
    sectionTypes: ['header', 'hero', 'product-carousel', 'brand-story', 'testimonials', 'footer'],
    pendingSectionTypes: ['image-text', 'newsletter'],
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
      'brand-story',
      'testimonials',
      'footer',
    ],
    pendingSectionTypes: ['image-text'],
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
    sectionTypes: ['hero', 'product-carousel', 'trust-strip', 'testimonials', 'footer'],
    pendingSectionTypes: ['image-text', 'newsletter'],
  },
];
