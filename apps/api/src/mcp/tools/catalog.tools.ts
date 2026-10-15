import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from '../resolve-store';
import { activePersonalisation } from '@ebda/shared';
import { ProductService } from '../../services/product.service';
import { ok } from './tool-result';

/**
 * Product rows returned by `ProductService.listPublic`/`getPublicById` carry
 * far more than a chat agent should see (categories, faqs, reviews, SEO
 * meta, raw option/variant graphs, etc — see `STOREFRONT_PRODUCT_SELECT` and
 * `PUBLIC_PRODUCT_DETAIL_SELECT` in `product.service.ts`). These mappers
 * narrow to the fields an agent actually needs, using the REAL field names
 * confirmed against `product.service.ts` (not guesses):
 *   - `p.nameAr` — real (bilingual name column).
 *   - `p.inStock` — real, set by `enrichStockFlags` (variant-aware aggregate,
 *     NOT the raw `inventory` column).
 *   - `p.images[].url` — real (`ProductImage.url`).
 *   - Products have NO `currency` column — currency is a store-level
 *     property, so it's read from `store.currency` (the `McpStore` passed
 *     into `registerCatalogTools`), not per-product.
 *   - Product-detail variants come back from `reshapePublicProductDetail`
 *     with the axis-title field renamed to `.name` (NOT `.title` as an
 *     earlier draft of this task assumed) — `{ id, name, nameAr, sku,
 *     price, ... }`. Mapped to `title` in the tool's own output for a
 *     stable agent-facing contract independent of the internal rename.
 */
/**
 * B0 commerce fields on the public product detail, narrowed for an agent. An agent that cannot
 * see `personalisation` cannot know a product needs a name before `add_to_cart` will accept it.
 * Every key is omitted when the merchant entered nothing, like the other optional fields.
 */
export function commerceDetail(p: any) {
  const personalisation = activePersonalisation(p.personalisation);
  const facts = Array.isArray(p.facts) ? p.facts : [];
  const chart = p.sizeChart;
  return {
    facts: facts.length
      ? facts.map((f: any) => ({
          name: f.key,
          name_ar: f.keyAr || undefined,
          value: f.value,
          value_ar: f.valueAr || undefined,
        }))
      : undefined,
    personalisation: personalisation
      ? {
          required: personalisation.required,
          label: personalisation.label || undefined,
          label_ar: personalisation.labelAr || undefined,
          max_length: personalisation.maxLength,
        }
      : undefined,
    lead_time_days: typeof p.leadTimeDays === 'number' ? p.leadTimeDays : undefined,
    size_chart: chart
      ? {
          name: chart.name || undefined,
          name_ar: chart.nameAr || undefined,
          unit: chart.unit,
          columns: (chart.columns ?? []).map((c: any) => ({
            label: c.label || undefined,
            label_ar: c.labelAr || undefined,
          })),
          rows: chart.rows,
        }
      : undefined,
  };
}

function toSummary(p: any, currency: string) {
  return {
    id: p.id,
    title: p.name,
    title_ar: p.nameAr ?? undefined,
    price: p.price,
    currency,
    availability: p.inStock === false ? 'out_of_stock' : 'in_stock',
    image: p.images?.[0]?.url ?? undefined,
  };
}

export function registerCatalogTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'get_store_info',
    {
      description: 'Basic info about this store (name, currency, whether it accepts orders).',
      inputSchema: {},
    },
    async () => ok({ name: store.name, slug: store.slug, currency: store.currency })
  );

  server.registerTool(
    'search_products',
    {
      description:
        "Search this store's active products by keyword (matches English and Arabic). Returns up to `limit` summaries.",
      inputSchema: {
        query: z.string().min(1).describe('search keywords'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const { products } = await ProductService.listPublic(store.id, {
        search: query,
        status: 'active',
        limit: limit ?? 20,
      });
      return ok({ products: products.map(p => toSummary(p, store.currency)) });
    }
  );

  server.registerTool(
    'get_product',
    {
      description: 'Full detail for one product (variants, price, availability).',
      inputSchema: { productId: z.string().min(1) },
    },
    async ({ productId }: { productId: string }) => {
      // Throws AppError(404, 'NOT_FOUND', 'Product not found') for an
      // unknown/inactive/deleted id — the SDK's CallToolRequestSchema
      // handler catches any thrown Error and surfaces it as
      // `{ content: [...], isError: true }` rather than a 500, so no
      // try/catch is needed here.
      const p: any = await ProductService.getPublicById(store.id, productId);
      return ok({
        id: p.id,
        title: p.name,
        title_ar: p.nameAr ?? undefined,
        description: p.description ?? undefined,
        price: p.price,
        currency: store.currency,
        availability: p.inStock === false ? 'out_of_stock' : 'in_stock',
        variants: (p.variants ?? []).map((v: any) => ({ id: v.id, title: v.name, price: v.price })),
        images: (p.images ?? []).map((i: any) => i.url),
        ...commerceDetail(p),
      });
    }
  );
}
