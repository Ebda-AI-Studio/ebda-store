// Sentry EBDA-API-Z wiring: abandonedCartService.process() must read storage_backend for N stores in ONE batched query and
// prime the customer-auth markers in chunks, for all three steps (detect, reminders, email sweep).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ids: [] as string[],
  sql: [] as string[],
  seen: [] as Array<'batch' | 'live'>,
}));
vi.mock('../../apps/api/src/cf/bindings', () => ({
  cfBindings: () => ({
    PLATFORM_DB: {
      prepare: (sql: string) => ({
        bind: (...v: string[]) => ({
          first: async () => {
            h.sql.push(sql);
            return { storage_backend: 'do' };
          },
          all: async () => {
            h.sql.push(sql);
            if (sql.includes('FROM stores'))
              return { results: v.map(id => ({ id, storage_backend: 'do' })) };
            return { results: [] };
          },
        }),
      }),
    },
  }),
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeDirectory: async () => h.ids.map(id => ({ id })),
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { acquireLock: async () => true, releaseLock: async () => undefined },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: async () => undefined }));
vi.mock('../../apps/api/src/services/cart-recovery-email.service', () => ({
  sweepCartRecoveryEmails: vi.fn(async () => {
    for (const id of h.ids) await backendFor(id);
    return { claimed: 0, failed: 0, stale: 0, requeued: 0 };
  }),
  CART_EMAIL_DEFAULT_DELAY_MINUTES: 60,
}));

import { abandonedCartService } from '../../apps/api/src/services/abandoned-cart.service';
import { backendFor } from '../../apps/api/src/lib/store-backend';
import { resetCustomerAuthCaches } from '../../apps/api/src/lib/customer-auth';

const storesReads = () => h.sql.filter(s => s.includes('FROM stores'));
const markerReads = () => h.sql.filter(s => s.includes('system_settings'));

beforeEach(() => {
  h.ids = Array.from({ length: 45 }, (_, i) => `store-${i}`);
  h.sql = [];
  resetCustomerAuthCaches();
  vi.restoreAllMocks();
});

describe('abandonedCartService.process wiring', () => {
  it('45 stores: one batched storage_backend read, no per-store reads, markers primed in chunks of 20 per step', async () => {
    vi.spyOn(abandonedCartService, 'detectNewAbandonments').mockImplementation(async () => {
      for (const id of h.ids) await backendFor(id);
    });
    vi.spyOn(abandonedCartService, 'processReminders').mockImplementation(async () => {
      for (const id of h.ids) await backendFor(id);
    });
    await abandonedCartService.process();
    expect(storesReads()).toHaveLength(1); // 45 ids < 90: one IN query
    expect(storesReads()[0]).toContain('IN (');
    expect(h.sql.some(s => s.includes('WHERE id = ?'))).toBe(false); // 45 x 3 steps would be 135 live reads
    // reminders prime (3 chunks), then email prime: the first reminders prime caches "off" for 10s so the email prime reads 0 more
    expect(markerReads().length).toBe(3);
  });
});
