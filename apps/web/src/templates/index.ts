import type { TemplateId } from '@ebda/shared';
import type { TemplateComponents } from './types';

// Lazy load templates for code splitting
const templates: Record<TemplateId, () => Promise<TemplateComponents>> = {
  modern: () =>
    import('./modern').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  classic: () =>
    import('./classic').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  minimal: () =>
    import('./minimal').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  bold: () =>
    import('./bold').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  elegant: () =>
    import('./elegant').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  dahab: () =>
    import('./dahab').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  qamar: () =>
    import('./qamar').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  souq: () =>
    import('./souq').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  jasmine: () =>
    import('./jasmine').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
  lamma: () =>
    import('./lamma').then(m => ({
      Header: m.Header,
      Footer: m.Footer,
      Hero: m.Hero,
      ProductCard: m.ProductCard,
      ProductGrid: m.ProductGrid,
      CategoryCard: m.CategoryCard,
      CategoryGrid: m.CategoryGrid,
      AnnouncementBar: m.AnnouncementBar,
      CartTable: m.CartTable,
      OrderSummary: m.OrderSummary,
      EmptyState: m.EmptyState,
      FormCard: m.FormCard,
    })),
};

/**
 * Get template components by ID
 */
export async function getTemplateComponents(templateId: TemplateId): Promise<TemplateComponents> {
  const loader = templates[templateId];
  if (!loader) {
    // Fallback to modern if template not found
    return templates.modern();
  }
  return loader();
}

/**
 * All available template IDs
 */
export const TEMPLATE_IDS: TemplateId[] = [
  'modern',
  'classic',
  'minimal',
  'bold',
  'elegant',
  'dahab',
  'qamar',
  'souq',
  'jasmine',
  'lamma',
];

// Re-export types
export type { TemplateComponents } from './types';
export * from './types';
