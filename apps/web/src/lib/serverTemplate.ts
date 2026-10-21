import type { TemplateId } from '@ebda/shared';
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
import ModernHero from '../templates/modern/Hero';
import ModernProductGrid from '../templates/modern/ProductGrid';
import ModernCategoryGrid from '../templates/modern/CategoryGrid';

import ClassicHero from '../templates/classic/Hero';
import ClassicProductGrid from '../templates/classic/ProductGrid';
import ClassicCategoryGrid from '../templates/classic/CategoryGrid';

import MinimalHero from '../templates/minimal/Hero';
import MinimalProductGrid from '../templates/minimal/ProductGrid';
import MinimalCategoryGrid from '../templates/minimal/CategoryGrid';

import BoldHero from '../templates/bold/Hero';
import BoldProductGrid from '../templates/bold/ProductGrid';
import BoldCategoryGrid from '../templates/bold/CategoryGrid';

import ElegantHero from '../templates/elegant/Hero';
import ElegantProductGrid from '../templates/elegant/ProductGrid';
import ElegantCategoryGrid from '../templates/elegant/CategoryGrid';

import DahabHero, { DahabHeroBanner, DahabHeroSlider } from '../templates/dahab/Hero';
import DahabProductGrid from '../templates/dahab/ProductGrid';
import DahabCategoryGrid, { DahabCategoryStrip } from '../templates/dahab/CategoryGrid';
import { DahabProductCarousel } from '../templates/dahab/ProductCarousel';
import { DahabTestimonialRow } from '../templates/dahab/TestimonialRow';

// Pecannbee-flow shared sections — same component for all 5 packs because
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
  modern: {
    Hero: ModernHero,
    ProductGrid: ModernProductGrid,
    CategoryGrid: ModernCategoryGrid,
    ...shared,
  },
  classic: {
    Hero: ClassicHero,
    ProductGrid: ClassicProductGrid,
    CategoryGrid: ClassicCategoryGrid,
    ...shared,
  },
  minimal: {
    Hero: MinimalHero,
    ProductGrid: MinimalProductGrid,
    CategoryGrid: MinimalCategoryGrid,
    ...shared,
  },
  bold: {
    Hero: BoldHero,
    ProductGrid: BoldProductGrid,
    CategoryGrid: BoldCategoryGrid,
    ...shared,
  },
  elegant: {
    Hero: ElegantHero,
    ProductGrid: ElegantProductGrid,
    CategoryGrid: ElegantCategoryGrid,
    ...shared,
  },
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
  // Qamar re-uses the minimal statics plus the shared sections (Ruling B1-1).
  qamar: {
    Hero: MinimalHero,
    ProductGrid: MinimalProductGrid,
    CategoryGrid: MinimalCategoryGrid,
    ...shared,
  },
  // Souq re-uses the minimal statics plus the shared sections (Ruling B2-1).
  souq: {
    Hero: MinimalHero,
    ProductGrid: MinimalProductGrid,
    CategoryGrid: MinimalCategoryGrid,
    ...shared,
  },
};

/**
 * Resolve homepage template components at the server level. Called from
 * the homepage server component to render the LCP (hero) without waiting
 * for client hydration.
 */
export function getHomepageTemplate(
  templateId: TemplateId | undefined
): HomepageTemplateComponents {
  return homepageTemplates[templateId ?? 'modern'] ?? homepageTemplates.modern;
}
