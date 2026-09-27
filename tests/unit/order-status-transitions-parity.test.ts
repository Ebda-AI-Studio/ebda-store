/**
 * #1936 — the merchant surfaces (admin list, admin order page, orders PWA) read
 * the transition map from @force/shared; the API enforces its own typed copy.
 * The PWA's private copy had drifted for months (no `cancelled` key, `refunded`
 * only from `delivered`). This pins the shared map to the API machine, key by
 * key and in order, so the next transition the API opens cannot go missing
 * from a surface again.
 */
import { describe, it, expect } from 'vitest';
import { ORDER_STATUS_TRANSITIONS } from '@force/shared';
import { VALID_ORDER_TRANSITIONS } from '@api/services/order-status-machine';
import { VALID_TRANSITIONS as ADMIN_TRANSITIONS } from '../../apps/admin/src/app/stores/[id]/orders/_components/types';
import { VALID_TRANSITIONS as PWA_TRANSITIONS } from '../../apps/orders/src/lib/orders';

describe('order status transition parity', () => {
  it('the shared map equals the API state machine', () => {
    expect(ORDER_STATUS_TRANSITIONS).toEqual(VALID_ORDER_TRANSITIONS);
  });

  it('the admin and the orders PWA both read the shared map', () => {
    expect(ADMIN_TRANSITIONS).toBe(ORDER_STATUS_TRANSITIONS);
    expect(PWA_TRANSITIONS).toBe(ORDER_STATUS_TRANSITIONS);
  });
});
