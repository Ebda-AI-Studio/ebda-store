/**
 * Store layout settings — controls which sections appear on the storefront
 * home page and how they render. Persisted as JSONB on `stores.layout_settings`.
 *
 * The storefront, the admin "Layout" page, and the API all consume this
 * single contract. Empty `{}` on the column means "use packaged defaults" —
 * `resolveLayoutSettings()` merges with `DEFAULT_LAYOUT_SETTINGS` so existing
 * tenants don't need a backfill.
 *
 * Defaults match the Pecannbee flow (see
 * docs/superpowers/specs/2026-04-26-pecannbee-home-flow-design.md): hero
 * slider, 3-up category grid with caption-below, both product carousels,
 * filter sidebar on PLP, testimonials.
 */

export type HeroMode = 'single' | 'slider';

export interface HeroSlide {
  /** R2 image URL — required */
  image: string;
  imageAr?: string;
  alt?: string;
  /** Optional headline rendered as overlay — pack styles vary */
  headline?: string;
  headlineAr?: string;
  /** Optional CTA */
  ctaText?: string;
  ctaTextAr?: string;
  ctaHref?: string;
}

export interface HeroSettings {
  enabled: boolean;
  mode: HeroMode;
  /** Autoplay interval in ms; ignored when mode === 'single' */
  autoplayMs: number;
  slides: HeroSlide[];
}

export type CategoriesLayout = 'grid' | 'horizontal';
export type CategoriesCaption = 'below' | 'overlay';

/**
 * Per-section heading override. When `title` / `titleAr` are non-empty
 * strings the storefront uses them as the section heading; otherwise the
 * platform's default applies (e.g. "Shop by Category"). The fields are
 * optional so old persisted layout blobs keep working.
 */
export interface SectionTitleOverride {
  title?: string;
  titleAr?: string;
}

export interface CategoriesSettings extends SectionTitleOverride {
  enabled: boolean;
  layout: CategoriesLayout;
  captionPosition: CategoriesCaption;
  desktopColumns: 2 | 3 | 4;
  mobileColumns: 1 | 2;
}

export interface ProductCarouselSettings extends SectionTitleOverride {
  enabled: boolean;
  /** Max products to load */
  limit: number;
}

export interface FilterSidebarSettings {
  enabled: boolean;
  /** When false on desktop, opens collapsed; users click to expand */
  defaultOpen: boolean;
}

export interface TestimonialsSettings extends SectionTitleOverride {
  enabled: boolean;
  minRating: number;
  verifiedOnly: boolean;
}

/**
 * Aspect-ratio + sizing contract shared across all 5 templates so pages look
 * consistent regardless of which template a store has selected.
 */
export interface SizingContract {
  heroAspect: '2.45:1' | '16:9' | '4:3';
  productImageAspect: '1:1' | '3:4';
  categoryImageAspect: '1:1' | '3:4' | '2:3';
}

export interface StoreLayoutSettings {
  hero: HeroSettings;
  categories: CategoriesSettings;
  newArrivals: ProductCarouselSettings;
  bestSellers: ProductCarouselSettings;
  filterSidebar: FilterSidebarSettings;
  testimonials: TestimonialsSettings;
  sizing: SizingContract;
}

/**
 * Pecannbee flow defaults. When a tenant's `layout_settings` column is `{}`
 * (the column default), `resolveLayoutSettings` returns this verbatim.
 */
export const DEFAULT_LAYOUT_SETTINGS: StoreLayoutSettings = {
  hero: {
    enabled: true,
    mode: 'slider',
    autoplayMs: 5000,
    slides: [],
  },
  categories: {
    enabled: true,
    layout: 'grid',
    captionPosition: 'below',
    desktopColumns: 3,
    mobileColumns: 2,
  },
  newArrivals: {
    enabled: true,
    limit: 16,
  },
  bestSellers: {
    enabled: true,
    limit: 12,
  },
  filterSidebar: {
    enabled: true,
    defaultOpen: true,
  },
  testimonials: {
    enabled: true,
    minRating: 4,
    verifiedOnly: true,
  },
  sizing: {
    heroAspect: '2.45:1',
    productImageAspect: '1:1',
    categoryImageAspect: '1:1',
  },
};

/**
 * Merge a partial / unknown blob from JSONB with the packaged defaults.
 * Tolerant of missing keys, malformed values, and unknown extras (forward
 * compatible).
 */
export function resolveLayoutSettings(input: unknown): StoreLayoutSettings {
  if (!input || typeof input !== 'object') return DEFAULT_LAYOUT_SETTINGS;
  const raw = input as Partial<StoreLayoutSettings>;

  return {
    hero: { ...DEFAULT_LAYOUT_SETTINGS.hero, ...(raw.hero ?? {}) },
    categories: { ...DEFAULT_LAYOUT_SETTINGS.categories, ...(raw.categories ?? {}) },
    newArrivals: { ...DEFAULT_LAYOUT_SETTINGS.newArrivals, ...(raw.newArrivals ?? {}) },
    bestSellers: { ...DEFAULT_LAYOUT_SETTINGS.bestSellers, ...(raw.bestSellers ?? {}) },
    filterSidebar: { ...DEFAULT_LAYOUT_SETTINGS.filterSidebar, ...(raw.filterSidebar ?? {}) },
    testimonials: { ...DEFAULT_LAYOUT_SETTINGS.testimonials, ...(raw.testimonials ?? {}) },
    sizing: { ...DEFAULT_LAYOUT_SETTINGS.sizing, ...(raw.sizing ?? {}) },
  };
}
