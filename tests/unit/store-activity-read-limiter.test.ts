/** CodeQL js/missing-rate-limiting: the merchant activity log GET is per-user rate limited (GETs skip the global mutation limiter). */
import { describe, it, expect } from 'vitest';
import storeActivityRoutes from '@api/routes/store-activity.routes';
import { adminReadLimiter } from '@api/middleware/security';

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
};

describe('GET /stores/:storeId/activity', () => {
  it('runs adminReadLimiter after the auth and store-access guards', () => {
    const layer = (storeActivityRoutes as unknown as { stack: Layer[] }).stack.find(
      l => l.route?.path === '/' && l.route.methods.get
    );
    expect(layer).toBeTruthy();
    const chain = layer!.route!.stack.map(h => h.handle);
    const at = chain.indexOf(adminReadLimiter);
    expect(at).toBeGreaterThan(0);
    // behind the guards, so an anonymous caller cannot burn a real user's bucket
    expect(at).toBeGreaterThanOrEqual(4);
  });
});
