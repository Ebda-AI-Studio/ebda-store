import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from './resolve-store';
import { registerCatalogTools } from './tools/catalog.tools';
import { registerCartTools } from './tools/cart.tools';
import { registerOrderTools } from './tools/order.tools';

/**
 * Builds a per-request MCP server scoped to a single store.
 *
 * Catalog tools (get_store_info/search_products/get_product, Task 4), cart
 * tools (add_to_cart/view_cart, Task 5), and order tools
 * (place_order/get_order_status, Task 6) are all registered here.
 * Kept as its own factory (rather than a single global server) because the
 * stateless Streamable HTTP transport requires a fresh server+transport pair
 * per request (see mcp.routes.ts).
 */
export function buildStoreMcpServer(store: McpStore): McpServer {
  const server = new McpServer({ name: `force-store-${store.slug}`, version: '1.0.0' });
  registerCatalogTools(server, store);
  registerCartTools(server, store);
  registerOrderTools(server, store);
  return server;
}
