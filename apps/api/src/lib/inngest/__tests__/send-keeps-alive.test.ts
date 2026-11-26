import { describe, it, expect, vi } from 'vitest';

vi.mock('../../jobs/dispatch', () => ({ dispatchEvents: vi.fn() }));

import { dispatchEvents } from '../../jobs/dispatch';
import { runWithWaitUntil } from '../../../cf/bindings';
import { inngest } from '../client';

// COD "Mark paid" sends order/created without awaiting it. On a Worker an unawaited promise dies with the response,
// so the accounting journal never ran (Amelia ORD-TOYND8-R19A2). send() must hand the start to ctx.waitUntil.
describe('inngest.send on a Worker', () => {
  it('registers the dispatch with waitUntil and still returns it to the caller', async () => {
    const started = Promise.resolve({ ids: [] as string[] });
    vi.mocked(dispatchEvents).mockReturnValueOnce(started);
    const kept: Array<Promise<unknown>> = [];
    const returned = runWithWaitUntil(
      p => kept.push(p),
      () => inngest.send({ name: 'order/created', data: { orderId: 'o', storeId: 's' } })
    );
    expect(kept).toHaveLength(1);
    await expect(returned).resolves.toEqual({ ids: [] });
  });

  it('a failed start still rejects for the caller and never becomes an unhandled rejection', async () => {
    vi.mocked(dispatchEvents).mockReturnValueOnce(Promise.reject(new Error('enqueue down')));
    const kept: Array<Promise<unknown>> = [];
    const returned = runWithWaitUntil(
      p => kept.push(p),
      () => inngest.send({ name: 'order/created', data: { orderId: 'o', storeId: 's' } })
    );
    await expect(returned).rejects.toThrow('enqueue down');
    await expect(kept[0]).resolves.toBeUndefined();
  });

  it('outside a Worker it just dispatches', async () => {
    vi.mocked(dispatchEvents).mockReturnValueOnce(Promise.resolve({ ids: [] }));
    await expect(
      inngest.send({ name: 'order/created', data: { orderId: 'o', storeId: 's' } })
    ).resolves.toEqual({ ids: [] });
  });
});
