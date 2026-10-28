/**
 * Task 12 review I2: MCP `search_products` reaches the query embed; its `query` is capped at the
 * same 100 characters as the storefront route (the JSON body limit is 10 MB, so an uncapped query
 * was a ~20 MB in-isolate cache key and an unbounded keyword pattern).
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v3';

vi.mock('../../apps/api/src/services/product.service', () => ({
  ProductService: { getPublicById: vi.fn(), listPublic: vi.fn() },
}));
const { registerCatalogTools } = await import('../../apps/api/src/mcp/tools/catalog.tools');

describe('MCP search_products query cap', () => {
  it('accepts 100 characters and refuses 101', () => {
    const defs = new Map<string, { inputSchema: Record<string, z.ZodTypeAny> }>();
    registerCatalogTools(
      { registerTool: (n: string, d: never) => void defs.set(n, d) } as never,
      { id: 's1', currency: 'EGP' } as never
    );
    const schema = z.object(defs.get('search_products')!.inputSchema);
    expect(schema.safeParse({ query: 'ك'.repeat(100) }).success).toBe(true);
    expect(schema.safeParse({ query: 'ك'.repeat(101) }).success).toBe(false);
  });
});
