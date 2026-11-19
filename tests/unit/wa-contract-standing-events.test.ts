/**
 * Contract v1.6 (STORE-STANDING-1) is in the vendored file even though the Store does not SEND these events yet (they ship with the
 * standing observer): the file is byte-pinned to Ebda Chat's copy, so the schema must parse them exactly as Chat does. Not sending them yet
 * is deliberate; this test only proves the shared schema knows them.
 */
import { describe, it, expect } from 'vitest';
import { parseStoreEvent } from '../../apps/api/src/contracts/wa-v1';

const base = {
  id: '3f1c2b7e-6a1d-4c55-9a0e-6b1f2d7c9e10',
  v: 1,
  storeId: 's1',
  occurredAt: '2026-11-17T09:00:00.000Z',
};

describe('wa-v1 v1.6 standing events', () => {
  it('parses store.suspended (with each reason), store.reactivated and store.deleted', () => {
    for (const reason of ['unpaid', 'over_store_limit', 'admin']) {
      expect(
        parseStoreEvent({ ...base, type: 'store.suspended', data: { reason, at: base.occurredAt } })
          .ok,
        reason
      ).toBe(true);
    }
    expect(
      parseStoreEvent({ ...base, type: 'store.reactivated', data: { at: base.occurredAt } }).ok
    ).toBe(true);
    expect(
      parseStoreEvent({ ...base, type: 'store.deleted', data: { at: base.occurredAt } }).ok
    ).toBe(true);
  });
  it('refuses an unknown suspension reason', () => {
    expect(
      parseStoreEvent({
        ...base,
        type: 'store.suspended',
        data: { reason: 'other', at: base.occurredAt },
      })
    ).toEqual({ ok: false, reason: 'invalid' });
  });
  it('still parses store.linked without storefrontOrigin (an older Store) and with it (v1.6)', () => {
    expect(parseStoreEvent({ ...base, type: 'store.linked', data: { ownerUserId: 'u1' } }).ok).toBe(
      true
    );
    expect(
      parseStoreEvent({
        ...base,
        type: 'store.linked',
        data: { ownerUserId: 'u1', storefrontOrigin: 'https://shop.example' },
      }).ok
    ).toBe(true);
  });
});
