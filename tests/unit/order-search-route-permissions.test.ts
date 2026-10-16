/**
 * Security review (Task 14): the store-wide order / customer search lookups
 * (`ebda_order_search_ids`) answer for the WHOLE store, and staff permissions live only in the app
 * layer. So every route that reaches them must enforce `orders:read` before calling:
 *   - GET /stores/:storeId/customers/search
 *   - GET /stores/:storeId/orders/export.xlsx
 *   - GET /stores/:storeId/orders (store viewers; a customer searching their own orders never
 *     calls the store-wide lookup, see orderSearchWhere `indexed: false`)
 * Source-level gate (the routes need a full app to run); mutation: remove the guard, test red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../', rel), 'utf8');

/** The `router.get('<path>', ...)` chain up to the async handler. */
function chain(src: string, route: string): string {
  const start = src.indexOf(`router.get(\n  '${route}'`);
  expect(start, `route ${route} not found`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('async (req', start));
}

describe('order / customer search routes enforce orders:read', () => {
  it('customers/search', () => {
    expect(chain(read('apps/api/src/routes/customers.routes.ts'), '/customers/search')).toContain(
      "requirePermission('orders:read')"
    );
  });
  it('orders export', () => {
    expect(chain(read('apps/api/src/routes/order.routes.ts'), '/export.xlsx')).toContain(
      "requirePermission('orders:read')"
    );
  });
  it('orders list: a store viewer needs orders:read', () => {
    const src = read('apps/api/src/routes/order.routes.ts');
    const list = src.slice(
      src.indexOf("router.get('/', authenticate"),
      src.indexOf('OrderService.list(')
    );
    expect(list).toContain("hasPermission(role as Role, 'orders:read')");
  });
});
