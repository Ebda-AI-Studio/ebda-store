import { normalizeLegacyTemplate, type TemplateId } from '@ebda/shared';
import type { TemplateComponents } from './types';

// Lazy load templates for code splitting
const templates: Record<TemplateId, () => Promise<TemplateComponents>> = {
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
export async function getTemplateComponents(
  templateId: TemplateId | string | null | undefined
): Promise<TemplateComponents> {
  // A retired Force skin name (SKIN-DEL-8) or an unknown id resolves to an Ebda template at read
  // time; there is no per-skin fallback to throw on.
  return templates[normalizeLegacyTemplate(templateId)]();
}

/**
 * All available template IDs
 */
export const TEMPLATE_IDS: TemplateId[] = ['dahab', 'qamar', 'souq', 'jasmine', 'lamma'];

// Re-export types
export type { TemplateComponents } from './types';
export * from './types';
