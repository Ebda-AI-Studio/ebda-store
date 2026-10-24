import { normalizeLegacyTemplate, type TemplateId } from '@ebda/shared';
import type {
  HeroProps,
  HeroBannerProps,
  HeroSliderProps,
  ProductGridProps,
  ProductCarouselProps,
  CategoryGridProps,
  CategoryStripProps,
  TestimonialRowProps,
} from '../templates/types';

// Static imports for the homepage's critical-path components. Each template's
// chunk gets bundled into the homepage server payload, but only the active
// template renders, so the runtime cost is bounded.
//
// Importing statically here is what enables the `/` route to render fully
// on the server — `useTemplateComponents` is a client-only hook (it runs
// inside useEffect via dynamic()) and forces the homepage to ship a JS
// loading state for the LCP element.
import BaseHero from '../templates/base/Hero';
import BaseProductGrid from '../templates/base/ProductGrid';
import BaseCategoryGrid from '../templates/base/CategoryGrid';

import DahabHero, { DahabHeroBanner, DahabHeroSlider } from '../templates/dahab/Hero';
import DahabProductGrid from '../templates/dahab/ProductGrid';
import DahabCategoryGrid, { DahabCategoryStrip } from '../templates/dahab/CategoryGrid';
import { DahabProductCarousel } from '../templates/dahab/ProductCarousel';
import { DahabTestimonialRow } from '../templates/dahab/TestimonialRow';

// Storefront-flow shared sections — same component for every pack because
// they're styled with theme tokens. Per-pack overrides can replace these
// later by exporting a same-named component from the pack's index.ts.
import { HeroBanner } from '../templates/shared/HeroBanner';
import { HeroSlider } from '../templates/shared/HeroSlider';
import { CategoryStrip } from '../templates/shared/CategoryStrip';
import { ProductCarousel } from '../templates/shared/ProductCarousel';
import { TestimonialRow } from '../templates/shared/TestimonialRow';

/**
 * Subset of template components needed by the homepage. Keeps the server
 * import surface small (no Header/Footer/Cart/etc. imports needed — those
 * are still resolved client-side via ShopChrome + useTemplateComponents).
 */
export interface HomepageTemplateComponents {
  Hero: React.ComponentType<HeroProps>;
  HeroBanner: React.ComponentType<HeroBannerProps>;
  HeroSlider: React.ComponentType<HeroSliderProps>;
  ProductGrid: React.ComponentType<ProductGridProps>;
  ProductCarousel: React.ComponentType<ProductCarouselProps>;
  CategoryGrid: React.ComponentType<CategoryGridProps>;
  CategoryStrip: React.ComponentType<CategoryStripProps>;
  TestimonialRow: React.ComponentType<TestimonialRowProps>;
}

// Shared section components used by every pack until per-pack overrides ship.
const shared = {
  HeroBanner,
  HeroSlider,
  CategoryStrip,
  ProductCarousel,
  TestimonialRow,
};

const homepageTemplates: Record<TemplateId, HomepageTemplateComponents> = {
  // Dahab owns every homepage section (builder Phase 3 pilot).
  dahab: {
    Hero: DahabHero,
    HeroBanner: DahabHeroBanner,
    HeroSlider: DahabHeroSlider,
    ProductGrid: DahabProductGrid,
    ProductCarousel: DahabProductCarousel,
    CategoryGrid: DahabCategoryGrid,
    CategoryStrip: DahabCategoryStrip,
    TestimonialRow: DahabTestimonialRow,
  },
  // Qamar re-uses the shared base statics plus the shared sections (Ruling B1-1).
  qamar: {
    Hero: BaseHero,
    ProductGrid: BaseProductGrid,
    CategoryGrid: BaseCategoryGrid,
    ...shared,
  },
  // Souq re-uses the shared base statics plus the shared sections (Ruling B2-1).
  souq: {
    Hero: BaseHero,
    ProductGrid: BaseProductGrid,
    CategoryGrid: BaseCategoryGrid,
    ...shared,
  },
  // Jasmine re-uses the shared base statics plus the shared sections (Ruling B3-1).
  jasmine: {
    Hero: BaseHero,
    ProductGrid: BaseProductGrid,
    CategoryGrid: BaseCategoryGrid,
    ...shared,
  },
  // Lamma re-uses the shared base statics plus the shared sections (Ruling B4-1).
  lamma: {
    Hero: BaseHero,
    ProductGrid: BaseProductGrid,
    CategoryGrid: BaseCategoryGrid,
    ...shared,
  },
};

/**
 * Resolve homepage template components at the server level. Called from
 * the homepage server component to render the LCP (hero) without waiting
 * for client hydration.
 */
export function getHomepageTemplate(
  templateId: TemplateId | string | null | undefined
): HomepageTemplateComponents {
  // A retired Force skin name (a store row not yet re-looked, SKIN-DEL-8) maps to its Ebda
  // template at read time; an unknown or missing id gets the default Ebda template.
  return homepageTemplates[normalizeLegacyTemplate(templateId)];
}
