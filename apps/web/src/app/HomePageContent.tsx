'use client';

import React from 'react';
import type { Product, Category } from '@/lib/api';
import { ShopChrome } from '../components';
import type { TemplateId, StoreLayoutSettings, PageDefinition } from '@force/shared';
import { layoutToDefinition } from '@force/shared';
import { PageRenderer } from '../builder/render/PageRenderer';

/**
 * Thin client wrapper for the homepage. Server-fetched products + categories
 * are passed in as props; the section bodies render through the visual
 * builder's `PageRenderer` (Phase 1), fed by the published `PageDefinition`
 * when the API sent one, else by the document derived from `layout` with the
 * adapter. The chrome (announcement/header/footer) stays on `ShopChrome`,
 * driven by `layout` exactly as before.
 *
 * This keeps the LCP element (hero image) on the SSR path — the previous
 * `'use client'` page.tsx blocked LCP behind JS parse → chunk fetch → API
 * round-trip.
 */
interface HomepageTestimonial {
  id: string;
  rating: number;
  title: string | null;
  comment: string;
  authorName: string;
  authorCity: string | null;
  createdAt: string;
}

interface HomePageContentProps {
  templateId: TemplateId;
  featuredProducts: Product[];
  newArrivals: Product[];
  bestSellers: Product[];
  categories: Category[];
  testimonials: HomepageTestimonial[];
  /** Additional products server-fetched for layout.extracarousels entries
   *  (category-slug and manual-ids sources). Merged into the union the
   *  storefront filters against. */
  extraProducts?: Product[];
  storeName: string;
  layout: StoreLayoutSettings;
  /** Published page document from `GET /public/stores/:id/layout`, already
   *  validated by the caller. Absent → derived from `layout`. */
  definition?: PageDefinition;
}

export function HomePageContent({
  templateId,
  featuredProducts,
  newArrivals,
  bestSellers,
  categories,
  testimonials,
  extraProducts,
  layout,
  definition,
}: HomePageContentProps) {
  const doc = definition ?? layoutToDefinition(layout);
  return (
    <ShopChrome layout={layout}>
      <PageRenderer
        definition={doc}
        templateId={templateId}
        featuredProducts={featuredProducts}
        newArrivals={newArrivals}
        bestSellers={bestSellers}
        categories={categories}
        testimonials={testimonials}
        extraProducts={extraProducts}
      />
    </ShopChrome>
  );
}
