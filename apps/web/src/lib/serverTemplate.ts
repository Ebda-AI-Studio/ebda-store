import type { TemplateId } from '@force/shared';
import type { HeroProps, ProductGridProps, CategoryGridProps } from '../templates/types';

// Static imports for the homepage's critical-path components (Hero,
// ProductGrid, CategoryGrid). Each template's chunk gets bundled into the
// homepage server payload, but only the active template renders, so the
// runtime cost is bounded to one Hero + one ProductGrid + one CategoryGrid.
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

/**
 * Subset of template components needed by the homepage. Keeps the server
 * import surface small (no Header/Footer/Cart/etc. imports needed — those
 * are still resolved client-side via ShopChrome + useTemplateComponents).
 */
export interface HomepageTemplateComponents {
  Hero: React.ComponentType<HeroProps>;
  ProductGrid: React.ComponentType<ProductGridProps>;
  CategoryGrid: React.ComponentType<CategoryGridProps>;
}

const homepageTemplates: Record<TemplateId, HomepageTemplateComponents> = {
  modern: { Hero: ModernHero, ProductGrid: ModernProductGrid, CategoryGrid: ModernCategoryGrid },
  classic: {
    Hero: ClassicHero,
    ProductGrid: ClassicProductGrid,
    CategoryGrid: ClassicCategoryGrid,
  },
  minimal: {
    Hero: MinimalHero,
    ProductGrid: MinimalProductGrid,
    CategoryGrid: MinimalCategoryGrid,
  },
  bold: { Hero: BoldHero, ProductGrid: BoldProductGrid, CategoryGrid: BoldCategoryGrid },
  elegant: {
    Hero: ElegantHero,
    ProductGrid: ElegantProductGrid,
    CategoryGrid: ElegantCategoryGrid,
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
