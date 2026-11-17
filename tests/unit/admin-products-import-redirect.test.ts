/**
 * IM2: `/stores/:id/products/import` was read as a product id ("This product no longer exists"). It redirects to the
 * Bulk page, where the import lives.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('admin redirects', () => {
  it('/products/import goes to /bulk for the same store', async () => {
    const config = require('../../apps/admin/next.config.js');
    const redirects = await (
      typeof config === 'function' ? config('phase', {}) : config
    ).redirects();
    const r = redirects.find((x: { source: string }) => x.source === '/stores/:id/products/import');
    expect(r).toMatchObject({ destination: '/stores/:id/bulk' });
  });
});
