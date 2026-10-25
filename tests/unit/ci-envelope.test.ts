/** commerce_outcomes v1 envelope (CI 1.2): strict per-type data, deterministic ids, no PII shapes. */
import { describe, expect, it } from 'vitest';
import {
  assertNoPiiShapes,
  ciEnvelopeSchema,
  deterministicEventId,
  newUlid,
  parseEnvelope,
} from '../../apps/api/src/lib/ci/envelope';
import { buildEnvelope } from '../../apps/api/src/lib/ci/port';

const STORE = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const ORDER = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6aa';
const KEY = 'a'.repeat(64);

const input = {
  type: 'order.placed' as const,
  seed: `order:${ORDER}`,
  occurredAt: new Date('2026-11-03T10:00:00Z'),
  storeId: STORE,
  orderId: ORDER,
  buyerKey: KEY,
  xstore: false,
  data: {
    totalMinor: 150000,
    currency: 'EGP',
    paymentMethod: 'cod',
    channel: 'web',
    itemCount: 2,
    areaKey: 'EG-C-nasr-city',
    isFirstOrderForBuyerInStore: true,
  },
};

describe('envelope', () => {
  it('builds a valid v1 envelope with a ULID-shaped deterministic id', async () => {
    const e = await buildEnvelope(input, 'store', new Date('2026-11-03T10:00:01Z'));
    expect(e.v).toBe(1);
    expect(e.eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(ciEnvelopeSchema.safeParse(e).success).toBe(true);
    expect(e.recordedAt).toBe(Date.parse('2026-11-03T10:00:01Z'));
  });

  it('the same occurrence yields the same id, another occurrence another', async () => {
    const a = await buildEnvelope(input);
    const b = await buildEnvelope({ ...input, occurredAt: new Date('2026-11-04T00:00:00Z') });
    const c = await buildEnvelope({ ...input, seed: 'order:other' });
    expect(b.eventId).toBe(a.eventId); // seed-derived, not clock-derived
    expect(c.eventId).not.toBe(a.eventId);
    // the type is part of the id: two types of the same seed never collide
    expect(await deterministicEventId('x:order.placed')).not.toBe(
      await deterministicEventId('x:order.cancelled')
    );
  });

  it('newUlid is time sortable', () => {
    const rand = () => new Uint8Array(16);
    expect(newUlid(1_000, rand) < newUlid(2_000_000, rand)).toBe(true);
    expect(newUlid(Date.now())).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('rejects an unknown key in data (a phone, a name, an address line cannot ride along)', async () => {
    const e = await buildEnvelope(input);
    for (const extra of ['phone', 'name', 'address1', 'email']) {
      const bad = { ...e, data: { ...e.data, [extra]: 'x' } };
      expect(() => parseEnvelope(bad), extra).toThrow();
    }
  });

  it('rejects a top-level extra key and a malformed buyer key', async () => {
    const e = await buildEnvelope(input);
    expect(() => parseEnvelope({ ...e, phone: '+201001234567' })).toThrow();
    expect(() => parseEnvelope({ ...e, buyerKey: '+201001234567' })).toThrow();
    expect(() => parseEnvelope({ ...e, buyerKey: 'A'.repeat(64) })).toThrow();
  });

  it('rejects a phone- or email-shaped string inside data', async () => {
    const e = await buildEnvelope({
      type: 'shipment.returned',
      seed: 's',
      occurredAt: new Date(),
      storeId: STORE,
      orderId: ORDER,
      buyerKey: null,
      xstore: false,
      data: {
        carrier: 'bosta',
        codMinor: 1,
        returnReasonCode: 'other',
        returnReasonRaw: 'ok text',
        attempts: 1,
        hoursSincePickup: 1,
      },
    });
    expect(() =>
      parseEnvelope({ ...e, data: { ...e.data, returnReasonRaw: 'call 01001234567' } })
    ).toThrow(/phone/);
    expect(() => parseEnvelope({ ...e, data: { ...e.data, returnReasonRaw: 'a@b.com' } })).toThrow(
      /phone/
    );
    expect(() => assertNoPiiShapes({ n: { deep: ['call +20 100 123 4567'] } })).toThrow();
    expect(() => assertNoPiiShapes({ areaKey: 'EG-GZ-6th-october' })).not.toThrow();
  });

  it('allows a null buyerKey (an order with no phone), never an invented one', async () => {
    const e = await buildEnvelope({ ...input, buyerKey: null });
    expect(e.buyerKey).toBeNull();
  });
});
