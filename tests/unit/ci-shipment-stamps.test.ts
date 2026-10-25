/** First-time shipment facts from the merged history: never overwritten, same answer on any path. */
import { describe, expect, it } from 'vitest';
import { shipmentStamps } from '../../apps/api/src/lib/ci/shipment-stamps';

const E = (status: string, ts: string, description?: string) => ({
  status,
  timestamp: `2026-11-03T${ts}Z`,
  description,
});
const fresh = {
  carrier: 'bosta',
  pickedUpAt: null,
  deliveredAt: null,
  returnedAt: null,
  deliveryAttempts: 0,
};

describe('shipmentStamps', () => {
  it('stamps the EARLIEST entry per state and marks it once', () => {
    const { data, marks } = shipmentStamps(
      [
        E('created', '10:00:00'),
        E('picked_up', '12:00:00'),
        E('picked_up', '12:30:00'),
        E('delivered', '18:00:00'),
      ],
      fresh,
      'carrier_poll'
    );
    expect(data.pickedUpAt?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(data.deliveredAt?.toISOString()).toBe('2026-11-03T18:00:00.000Z');
    expect(marks.map(m => m.kind)).toEqual(['picked_up', 'delivered']);
  });

  it('never overwrites a stamp and marks nothing a second time (a double poll)', () => {
    const cur = { ...fresh, pickedUpAt: new Date('2026-11-03T12:00:00Z') };
    const { data, marks } = shipmentStamps(
      [E('picked_up', '12:00:00'), E('in_transit', '13:00:00')],
      cur,
      'carrier_poll'
    );
    expect(data).toEqual({});
    expect(marks).toEqual([]);
  });

  it('counts failed attempts and marks only the new ones, with the carrier text', () => {
    const history = [
      E('picked_up', '10:00:00'),
      E('failed', '12:00:00', 'Consignee not available'),
      E('failed', '15:00:00', 'No answer'),
    ];
    const first = shipmentStamps(
      history,
      { ...fresh, pickedUpAt: new Date('2026-11-03T10:00:00Z') },
      'carrier_webhook'
    );
    expect(first.data.deliveryAttempts).toBe(2);
    expect(first.marks.map(m => [m.kind, m.attemptNo])).toEqual([
      ['attempted', 1],
      ['attempted', 2],
    ]);
    const later = shipmentStamps(
      history,
      { ...fresh, pickedUpAt: new Date('2026-11-03T10:00:00Z'), deliveryAttempts: 2 },
      'carrier_poll'
    );
    expect(later.marks).toEqual([]);
  });

  it('first return: reason from the entry, else from the failed attempt before it; closed code', () => {
    const a = shipmentStamps(
      [E('failed', '12:00:00', 'Consignee refused'), E('returned', '20:00:00')],
      { ...fresh, deliveryAttempts: 1 },
      'carrier_poll'
    );
    expect(a.data).toMatchObject({
      returnReasonCode: 'customer_refused',
      returnReasonRaw: 'Consignee refused',
    });
    const b = shipmentStamps(
      [E('returned', '20:00:00', 'Customer postponed delivery')],
      fresh,
      'carrier_poll'
    );
    expect(b.data.returnReasonCode).toBe('customer_postponed');
    const c = shipmentStamps([E('returned', '20:00:00')], fresh, 'carrier_poll');
    expect(c.data).toMatchObject({ returnReasonCode: 'other', returnReasonRaw: null });
  });

  it('the merchant\'s own "Updated by the merchant" note is not a carrier reason', () => {
    const r = shipmentStamps(
      [E('returned', '20:00:00', 'Updated by the merchant')],
      fresh,
      'merchant_manual'
    );
    expect(r.data).toMatchObject({ returnReasonCode: 'other', returnReasonRaw: null });
  });

  it('scrubs a phone number out of the stored reason', () => {
    const r = shipmentStamps(
      [E('returned', '20:00:00', 'Customer refused, call 01001234567')],
      fresh,
      'carrier_poll'
    );
    expect(r.data.returnReasonRaw).toBe('Customer refused, call [phone]');
  });

  it("an attempt's reason in the Inngest-bound mark is already scrubbed (no raw carrier text leaves)", () => {
    const r = shipmentStamps(
      [E('failed', '12:00:00', 'Not available, call ٠١٠١٢٣٤٥٦٧٨ or 01001234567')],
      fresh,
      'carrier_webhook'
    );
    expect(r.marks[0]).toMatchObject({
      kind: 'attempted',
      reasonRaw: 'Not available, call [phone] or [phone]',
    });
  });
});
