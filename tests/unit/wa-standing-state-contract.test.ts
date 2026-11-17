/**
 * The PRODUCER of store.suspended / store.reactivated / store.deleted (Ruling STORE-STANDING-1) must emit envelopes the SHARED parser
 * (the byte-pinned contract, the same file Ebda Chat validates with) accepts, for every reason it can send.
 */
import { describe, it, expect } from 'vitest';
import { buildStoreEvent } from '@api/lib/wa/events';
import { parseStoreEvent } from '@api/contracts/wa-v1';

const at = '2026-11-17T09:00:00.000Z';

describe('standing events built by the producer pass the shared parser', () => {
  it.each([
    [
      'store.suspended unpaid',
      { type: 'store.suspended', storeId: 's1', data: { reason: 'unpaid', at } },
    ],
    [
      'store.suspended over_store_limit',
      { type: 'store.suspended', storeId: 's1', data: { reason: 'over_store_limit', at } },
    ],
    [
      'store.suspended admin',
      { type: 'store.suspended', storeId: 's1', data: { reason: 'admin', at } },
    ],
    ['store.reactivated', { type: 'store.reactivated', storeId: 's1', data: { at } }],
    ['store.deleted', { type: 'store.deleted', storeId: 's1', data: { at } }],
  ] as const)('%s', async (_n, input) => {
    const event = await buildStoreEvent(input as never, {
      seed: `t:${_n}`,
      occurredAt: new Date(at),
    });
    const parsed = parseStoreEvent(JSON.parse(JSON.stringify(event)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.event.type).toBe(input.type);
  });
});
