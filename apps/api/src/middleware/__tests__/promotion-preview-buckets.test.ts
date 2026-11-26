import { describe, expect, it } from 'vitest';
import { limitPlanOf } from '../limit-plan';
import { promotionBrowsePreviewLimiter, promotionPreviewLimiter } from '../security';
import promotionRoutes from '../../routes/promotion.routes';

// Browsing (PDP + cart) must never spend checkout's preview budget: on a carrier-shared IP a 429 at checkout makes the
// promotion line vanish. Separate store names = separate counters (`rl:<name>:<ip>`).
type Layer = { route?: { path: string; stack: { handle: unknown }[] } };

describe('promotion preview rate-limit buckets', () => {
  it('browse and checkout use different counters; browse is more generous but bounded', () => {
    const checkout = limitPlanOf(promotionPreviewLimiter);
    const browse = limitPlanOf(promotionBrowsePreviewLimiter);
    expect(checkout?.name).toBe('promotion-preview');
    expect(browse?.name).toBe('promo-preview-browse');
    expect(browse?.name).not.toBe(checkout?.name);
  });

  it('each route is guarded by its own limiter (browse requests never touch checkout bucket)', () => {
    const stack = (promotionRoutes as unknown as { stack: Layer[] }).stack;
    const handlersOf = (path: string) =>
      stack.find(l => l.route?.path === path)?.route?.stack.map(s => s.handle) ?? [];
    const checkout = handlersOf('/public/:storeId/promotions/preview');
    const browse = handlersOf('/public/:storeId/promotions/preview-browse');
    expect(checkout).toContain(promotionPreviewLimiter);
    expect(checkout).not.toContain(promotionBrowsePreviewLimiter);
    expect(browse).toContain(promotionBrowsePreviewLimiter);
    expect(browse).not.toContain(promotionPreviewLimiter);
  });
});
