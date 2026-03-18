/**
 * Shipping Carrier Integrations — Unit Tests
 * Tests for carrier types, status constants, status mappings, and registry
 */

import { describe, it, expect } from 'vitest';

import {
  SHIPMENT_STATUSES,
  CARRIER_CODES,
  type ShipmentStatus,
} from '../../apps/api/src/services/carriers/types';

import { ICarryCarrier } from '../../apps/api/src/services/carriers/icarry.carrier';
import { AramexCarrier } from '../../apps/api/src/services/carriers/aramex.carrier';
import { iCarryCarrier } from '../../apps/api/src/services/carriers/icarry.carrier';
import { aramexCarrier } from '../../apps/api/src/services/carriers/aramex.carrier';

// ─── SHIPMENT_STATUSES ────────────────────────────────────────────────────────

describe('SHIPMENT_STATUSES', () => {
  it('has exactly 8 values', () => {
    expect(SHIPMENT_STATUSES).toHaveLength(8);
  });

  it('contains all expected status strings', () => {
    expect(SHIPMENT_STATUSES).toContain('created');
    expect(SHIPMENT_STATUSES).toContain('picked_up');
    expect(SHIPMENT_STATUSES).toContain('in_transit');
    expect(SHIPMENT_STATUSES).toContain('out_for_delivery');
    expect(SHIPMENT_STATUSES).toContain('delivered');
    expect(SHIPMENT_STATUSES).toContain('failed');
    expect(SHIPMENT_STATUSES).toContain('returned');
    expect(SHIPMENT_STATUSES).toContain('cancelled');
  });
});

// ─── CARRIER_CODES ────────────────────────────────────────────────────────────

describe('CARRIER_CODES', () => {
  it('has exactly 2 entries', () => {
    expect(CARRIER_CODES).toHaveLength(2);
  });

  it('contains icarry', () => {
    expect(CARRIER_CODES).toContain('icarry');
  });

  it('contains aramex', () => {
    expect(CARRIER_CODES).toContain('aramex');
  });
});

// ─── iCarry status mapping ────────────────────────────────────────────────────

describe('iCarry status mapping via processWebhook', () => {
  const carrier = new ICarryCarrier();

  const cases: Array<[string, ShipmentStatus]> = [
    ['pending', 'created'],
    ['created', 'created'],
    ['picked_up', 'picked_up'],
    ['on_the_way', 'in_transit'],
    ['in_transit', 'in_transit'],
    ['out_for_delivery', 'out_for_delivery'],
    ['arrived', 'out_for_delivery'],
    ['delivered', 'delivered'],
    ['failed', 'failed'],
    ['failed_delivery', 'failed'],
    ['cancelled', 'cancelled'],
    ['returned', 'returned'],
    ['return_in_transit', 'returned'],
  ];

  it('covers all ShipmentStatus values in its mapping', () => {
    const mappedStatuses = new Set(cases.map(([, expected]) => expected));
    for (const status of SHIPMENT_STATUSES) {
      expect(mappedStatuses).toContain(status);
    }
  });

  cases.forEach(([rawStatus, expectedNormalized]) => {
    it(`maps iCarry status "${rawStatus}" → "${expectedNormalized}"`, () => {
      const result = carrier.processWebhook({ tracking_number: 'TRK-001', status: rawStatus }, {});
      expect(result).not.toBeNull();
      expect(result!.status).toBe(expectedNormalized);
    });
  });

  it('returns null for payload missing tracking_number', () => {
    const result = carrier.processWebhook({ status: 'delivered' }, {});
    expect(result).toBeNull();
  });

  it('returns null for payload missing status', () => {
    const result = carrier.processWebhook({ tracking_number: 'TRK-001' }, {});
    expect(result).toBeNull();
  });

  it('returns null for non-object payload', () => {
    const result = carrier.processWebhook('not-an-object', {});
    expect(result).toBeNull();
  });
});

// ─── Aramex status mapping ────────────────────────────────────────────────────

describe('Aramex status mapping via processWebhook', () => {
  const carrier = new AramexCarrier();

  const cases: Array<[string, ShipmentStatus]> = [
    ['SH005', 'created'],
    ['SH006', 'created'],
    ['SH010', 'picked_up'],
    ['SH011', 'picked_up'],
    ['SH012', 'picked_up'],
    ['SH020', 'in_transit'],
    ['SH021', 'in_transit'],
    ['SH022', 'in_transit'],
    ['SH023', 'in_transit'],
    ['SH024', 'in_transit'],
    ['SH025', 'in_transit'],
    ['SH030', 'in_transit'],
    ['SH040', 'out_for_delivery'],
    ['SH041', 'out_for_delivery'],
    ['SH050', 'delivered'],
    ['SH051', 'delivered'],
    ['SH060', 'failed'],
    ['SH061', 'failed'],
    ['SH062', 'failed'],
    ['SH063', 'failed'],
    ['SH064', 'failed'],
    ['SH070', 'returned'],
    ['SH071', 'returned'],
    ['SH072', 'returned'],
    ['SH080', 'cancelled'],
    ['SH081', 'cancelled'],
  ];

  it('covers all ShipmentStatus values in its mapping', () => {
    const mappedStatuses = new Set(cases.map(([, expected]) => expected));
    for (const status of SHIPMENT_STATUSES) {
      expect(mappedStatuses).toContain(status);
    }
  });

  cases.forEach(([updateCode, expectedNormalized]) => {
    it(`maps Aramex UpdateCode "${updateCode}" → "${expectedNormalized}"`, () => {
      const result = carrier.processWebhook(
        { WaybillNumber: 'AWB-123', UpdateCode: updateCode },
        {}
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(expectedNormalized);
    });
  });

  it('returns null for payload missing WaybillNumber and ShipmentNumber', () => {
    const result = carrier.processWebhook({ UpdateCode: 'SH050' }, {});
    expect(result).toBeNull();
  });

  it('returns null for payload missing UpdateCode', () => {
    const result = carrier.processWebhook({ WaybillNumber: 'AWB-123' }, {});
    expect(result).toBeNull();
  });

  it('returns null for non-object payload', () => {
    const result = carrier.processWebhook(null, {});
    expect(result).toBeNull();
  });
});

// ─── Carrier registry ─────────────────────────────────────────────────────────

describe('Carrier registry', () => {
  it('resolves icarry to an ICarryCarrier instance', () => {
    expect(iCarryCarrier).toBeInstanceOf(ICarryCarrier);
    expect(iCarryCarrier.code).toBe('icarry');
    expect(iCarryCarrier.name).toBe('iCarry');
  });

  it('resolves aramex to an AramexCarrier instance', () => {
    expect(aramexCarrier).toBeInstanceOf(AramexCarrier);
    expect(aramexCarrier.code).toBe('aramex');
    expect(aramexCarrier.name).toBe('Aramex');
  });

  it('both carriers implement the ShippingCarrierProvider interface', () => {
    for (const carrier of [iCarryCarrier, aramexCarrier]) {
      expect(typeof carrier.createShipment).toBe('function');
      expect(typeof carrier.trackShipment).toBe('function');
      expect(typeof carrier.cancelShipment).toBe('function');
      expect(typeof carrier.processWebhook).toBe('function');
      expect(typeof carrier.testConnection).toBe('function');
    }
  });
});

// ─── ShipmentStatus type validation ──────────────────────────────────────────

describe('ShipmentStatus type validation', () => {
  it('SHIPMENT_STATUSES array acts as exhaustive list of ShipmentStatus values', () => {
    // Every string in SHIPMENT_STATUSES must be a valid ShipmentStatus
    const statuses: ShipmentStatus[] = SHIPMENT_STATUSES as ShipmentStatus[];
    expect(statuses).toHaveLength(8);
  });

  it('each status is a non-empty string', () => {
    for (const status of SHIPMENT_STATUSES) {
      expect(typeof status).toBe('string');
      expect(status.length).toBeGreaterThan(0);
    }
  });

  it('no duplicate statuses exist', () => {
    const unique = new Set(SHIPMENT_STATUSES);
    expect(unique.size).toBe(SHIPMENT_STATUSES.length);
  });
});
