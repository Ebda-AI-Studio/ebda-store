/** CodeQL js/missing-rate-limiting: the merchant's GET of its tax change request is per-user rate limited (GETs skip the global limiter). */
import { describe, it, expect } from 'vitest';
import taxRoutes from '@api/routes/tax.routes';
import { adminReadLimiter } from '@api/middleware/security';

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
};

describe('GET /:storeId/tax/change-request', () => {
  it('runs adminReadLimiter in its chain', () => {
    const layer = (taxRoutes as unknown as { stack: Layer[] }).stack.find(
      l => l.route?.path === '/:storeId/tax/change-request' && l.route.methods.get
    );
    expect(layer).toBeTruthy();
    expect(layer!.route!.stack.some(h => h.handle === adminReadLimiter)).toBe(true);
  });
});
