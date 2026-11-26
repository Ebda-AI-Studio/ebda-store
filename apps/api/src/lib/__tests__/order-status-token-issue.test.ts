import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('STORE-QA-41 guest status link is only issued to the holder of THAT order view token', () => {
  it('GET /public/orders/:id signs a status token only for a guest order with the view token', () => {
    const src = readFileSync(join(__dirname, '../../routes/public.routes.ts'), 'utf8');
    const i = src.indexOf('signOrderStatusLinkToken(storeId, order.id)');
    expect(i).toBeGreaterThan(0);
    const guard = src.slice(i - 260, i);
    expect(guard).toContain('order.customerId === null');
    expect(guard).toContain('requestHoldsOrderViewToken(req, order.id)');
  });
});
