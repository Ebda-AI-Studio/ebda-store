/**
 * socket.service on Workers: emits go to the StoreRealtime Durable Object, not to socket.io
 * (apps/api/src/services/socket.service.ts). The runtime flag is forced on for this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@api/lib/runtime', () => ({ isWorkers: true }));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/lib/definer', () => ({ getUserState: vi.fn() }));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { socketService } from '@api/services/socket.service';
import { clearCfBindings, setCfBindings, type CfBindings } from '@api/cf/bindings';

const delivered: Array<{ kind: string; name: string; args: unknown[] }> = [];

beforeEach(() => {
  delivered.length = 0;
  setCfBindings({
    STORE_REALTIME: {
      idFromName: (n: string) => n,
      get: (id: unknown) =>
        ({
          deliver: async (...args: unknown[]) =>
            void delivered.push({ kind: 'user', name: String(id), args }),
          emitStore: async (...args: unknown[]) =>
            void delivered.push({ kind: 'store', name: String(id), args }),
        }) as never,
    },
  } as unknown as CfBindings);
});
afterEach(() => clearCfBindings());

const flush = () => new Promise(r => setTimeout(r, 0));

describe('socketService on Workers', () => {
  it('notifyStore -> the store room DO, event `notification`', async () => {
    socketService.notifyStore('store-1', {
      type: 'new_order',
      title: 't',
      message: 'm',
      createdAt: new Date(),
    });
    await flush();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: 'store', name: 'store:store-1' });
    expect(delivered[0].args[0]).toBe('store-1');
    expect(delivered[0].args[1]).toBe('notification');
  });

  it('broadcastUiRefresh -> the store room DO, event `ui-refresh` with the same payload', async () => {
    socketService.broadcastUiRefresh('store-1', { name: 'ui/journal-posted', data: { id: 1 } });
    await flush();
    expect(delivered[0].args.slice(1)).toEqual([
      'ui-refresh',
      { name: 'ui/journal-posted', data: { id: 1 } },
    ]);
  });

  it('notifyUser -> the user DO', async () => {
    socketService.notifyUser('user-9', {
      type: 'order_status',
      title: 't',
      message: 'm',
      createdAt: new Date(),
    });
    await flush();
    expect(delivered[0]).toMatchObject({ kind: 'user', name: 'user:user-9' });
    expect((delivered[0].args[0] as { event: string }).event).toBe('notification');
  });

  it('is a silent no-op without the binding (tests, a Worker without realtime)', async () => {
    clearCfBindings();
    expect(() =>
      socketService.notifyStore('s', { type: 'x', title: 't', message: 'm', createdAt: new Date() })
    ).not.toThrow();
  });

  it('a failing DO call never throws into the caller (best-effort, like socket.io)', async () => {
    setCfBindings({
      STORE_REALTIME: {
        idFromName: (n: string) => n,
        get: () => ({ emitStore: async () => Promise.reject(new Error('do reset')) }) as never,
      },
    } as unknown as CfBindings);
    expect(() =>
      socketService.notifyStore('s', { type: 'x', title: 't', message: 'm', createdAt: new Date() })
    ).not.toThrow();
    await flush();
  });
});
