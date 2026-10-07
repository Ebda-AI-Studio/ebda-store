/**
 * Section registry (visual builder Phase 1).
 *
 * One entry per section TYPE a `PageDefinition` may contain. Phase 1 covers
 * exactly the sections the storefront already renders — no new renderers —
 * so every entry maps onto a key of the legacy `StoreLayoutSettings`
 * (`legacyKey`), and its props are validated by the SAME Zod schema the
 * layout PUT uses (`storeLayoutSchema.shape[legacyKey]`). Adding a section
 * type is a registry entry, not three hand-kept key lists.
 *
 * Concepts (typed component registration, slots, content-vs-design props)
 * follow the Phase 0 comparison in docs/plans/2026-10-07-builder-phase0-gap-matrix.md.
 * No third-party code is used here.
 */
import { z } from 'zod';
import { storeLayoutSchema } from './layout-schema';
import type { LegacyHomeSectionKey } from './section-keys';

export type SectionPlacement = 'chrome-top' | 'body' | 'chrome-bottom';
export type Viewport = 'desktop' | 'tablet' | 'mobile';
export const VIEWPORTS: readonly Viewport[] = ['desktop', 'tablet', 'mobile'];

/**
 * Viewport ranges the renderer maps responsive overrides onto (Tailwind
 * defaults; `md` = 768 is the storefront's existing mobile/desktop line).
 * BUILDER-PREVIEW-1: the editor previews all three.
 */
export const VIEWPORT_RANGES: Record<Viewport, { minPx: number; maxPx: number | null }> = {
  mobile: { minPx: 0, maxPx: 767 },
  tablet: { minPx: 768, maxPx: 1023 },
  desktop: { minPx: 1024, maxPx: null },
};

/** Layout keys a registry entry can project onto. */
export type LegacyLayoutKey = LegacyHomeSectionKey | 'announcement' | 'header' | 'footer';

export interface SectionDefinition {
  type: string;
  labelEn: string;
  labelAr: string;
  /** Key in the legacy layout. `extraCarousels` entries use `'extraCarousels'`. */
  legacyKey: LegacyLayoutKey | 'extraCarousels';
  /** Storefront renderer the web app maps this type onto. */
  rendererKey: string;
  cardinality: 'one' | 'many';
  maxCount: number;
  placement: SectionPlacement;
  /** Nested slots. Empty in v1: no section accepts children. */
  slots: readonly string[];
  /**
   * Responsive capability: which viewports may hide the section, and which
   * props may be overridden per viewport (v1: only what the storefront
   * already renders per breakpoint).
   */
  responsive: {
    hidden: readonly Viewport[];
    props: Partial<Record<Viewport, readonly string[]>>;
  };
  /** Bilingual text pairs [en, ar]. Direction is never stored; the visitor's locale picks. */
  localizedProps: ReadonlyArray<readonly [string, string]>;
  /**
   * Whether the legacy object carries a required `enabled` flag (the five
   * original sections) or an optional one that falls back to a store flag.
   */
  enabledRequired: boolean;
  /** Validates the reconstructed legacy section object. */
  propsSchema: z.ZodTypeAny;
}

const shape = storeLayoutSchema.shape;
const unwrap = (s: z.ZodTypeAny): z.ZodTypeAny =>
  s instanceof z.ZodOptional ? unwrap(s.unwrap()) : s;
const extraCarouselSchema = (unwrap(shape.extraCarousels) as z.ZodArray<z.ZodTypeAny>).element;

const TITLE_PAIRS = [
  ['title', 'titleAr'],
  ['kicker', 'kickerAr'],
  ['subtitle', 'subtitleAr'],
] as const;

const ALL_VIEWPORTS: readonly Viewport[] = VIEWPORTS;

function def(
  d: Omit<SectionDefinition, 'propsSchema' | 'slots' | 'maxCount' | 'cardinality'> &
    Partial<Pick<SectionDefinition, 'cardinality' | 'maxCount'>>
): SectionDefinition {
  const key = d.legacyKey;
  return {
    cardinality: 'one',
    maxCount: 1,
    slots: [],
    ...d,
    propsSchema: key === 'extraCarousels' ? extraCarouselSchema : unwrap(shape[key]),
  };
}

export const SECTION_REGISTRY: readonly SectionDefinition[] = [
  def({
    type: 'announcement',
    labelEn: 'Announcement bar',
    labelAr: 'شريط الإعلانات',
    legacyKey: 'announcement',
    rendererKey: 'chrome.announcement',
    placement: 'chrome-top',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: [],
    enabledRequired: false,
  }),
  def({
    type: 'header',
    labelEn: 'Header',
    labelAr: 'الترويسة',
    legacyKey: 'header',
    rendererKey: 'chrome.header',
    placement: 'chrome-top',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: [],
    enabledRequired: false,
  }),
  def({
    type: 'hero',
    labelEn: 'Hero banner',
    labelAr: 'البانر الرئيسي',
    legacyKey: 'hero',
    rendererKey: 'home.hero',
    placement: 'body',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: [
      ['headline', 'headlineAr'],
      ['ctaText', 'ctaTextAr'],
      ['image', 'imageAr'],
    ],
    enabledRequired: true,
  }),
  def({
    type: 'category-grid',
    labelEn: 'Categories',
    labelAr: 'الفئات',
    legacyKey: 'categories',
    rendererKey: 'home.categories',
    placement: 'body',
    responsive: {
      hidden: ALL_VIEWPORTS,
      // The storefront already renders a separate mobile layout + caption.
      props: { mobile: ['layout', 'captionPosition'] },
    },
    localizedProps: TITLE_PAIRS,
    enabledRequired: true,
  }),
  def({
    type: 'new-arrivals',
    labelEn: 'New arrivals',
    labelAr: 'أحدث المنتجات',
    legacyKey: 'newArrivals',
    rendererKey: 'home.newArrivals',
    placement: 'body',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: TITLE_PAIRS,
    enabledRequired: true,
  }),
  def({
    type: 'best-sellers',
    labelEn: 'Best sellers',
    labelAr: 'الأكثر مبيعاً',
    legacyKey: 'bestSellers',
    rendererKey: 'home.bestSellers',
    placement: 'body',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: TITLE_PAIRS,
    enabledRequired: true,
  }),
  def({
    type: 'brand-story',
    labelEn: 'Brand story',
    labelAr: 'قصة العلامة',
    legacyKey: 'brandStory',
    rendererKey: 'home.brandStory',
    placement: 'body',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: [],
    enabledRequired: false,
  }),
  def({
    type: 'blog-carousel',
    labelEn: 'Blog posts',
    labelAr: 'المدونة',
    legacyKey: 'blogCarousel',
    rendererKey: 'home.blogCarousel',
    placement: 'body',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: [],
    enabledRequired: false,
  }),
  def({
    type: 'trust-strip',
    labelEn: 'Trust strip',
    labelAr: 'شريط الثقة',
    legacyKey: 'trustStrip',
    rendererKey: 'home.trustStrip',
    placement: 'body',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: [],
    enabledRequired: false,
  }),
  def({
    type: 'testimonials',
    labelEn: 'Customer reviews',
    labelAr: 'آراء العملاء',
    legacyKey: 'testimonials',
    rendererKey: 'home.testimonials',
    placement: 'body',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: [['title', 'titleAr']],
    enabledRequired: true,
  }),
  def({
    type: 'product-carousel',
    labelEn: 'Product carousel',
    labelAr: 'شريط منتجات',
    legacyKey: 'extraCarousels',
    rendererKey: 'home.productCarousel',
    placement: 'body',
    cardinality: 'many',
    // Same cap as the layout schema (`extraCarousels.max(8)`).
    maxCount: 8,
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: TITLE_PAIRS,
    enabledRequired: false,
  }),
  def({
    type: 'footer',
    labelEn: 'Footer',
    labelAr: 'التذييل',
    legacyKey: 'footer',
    rendererKey: 'chrome.footer',
    placement: 'chrome-bottom',
    responsive: { hidden: ALL_VIEWPORTS, props: {} },
    localizedProps: [],
    enabledRequired: false,
  }),
];

const BY_TYPE = new Map(SECTION_REGISTRY.map(d => [d.type, d]));
const BY_LEGACY_KEY = new Map(SECTION_REGISTRY.map(d => [d.legacyKey, d]));

export function getSectionDefinition(type: string): SectionDefinition | undefined {
  return BY_TYPE.get(type);
}

export function sectionDefinitionForLegacyKey(
  key: LegacyLayoutKey | 'extraCarousels'
): SectionDefinition {
  const d = BY_LEGACY_KEY.get(key);
  if (!d) throw new Error(`no section registered for layout key ${key}`);
  return d;
}

/** Stable section id for a fixed (cardinality one) legacy key: `newArrivals` -> `new-arrivals`. */
export function legacySectionId(key: LegacyLayoutKey): string {
  return key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}
