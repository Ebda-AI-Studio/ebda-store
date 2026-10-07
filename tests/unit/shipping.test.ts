/**
 * Shipping Carrier Integrations — Unit Tests
 * Tests for carrier types, status constants and the registry (per-carrier mapping lives in each carrier's contract tests)
 */

import { describe, it, expect } from 'vitest';

import {
  SHIPMENT_STATUSES,
  CARRIER_CODES,
  type ShipmentStatus,
} from '../../apps/api/src/services/carriers/types';

import { CARRIER_REGISTRY } from '../../apps/api/src/services/carriers/registry';

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
  it('has exactly 5 entries (Bosta, ShipBlu, Mylerz, Aramex, manual: ruling PROVIDERS-3)', () => {
    expect([...CARRIER_CODES].sort()).toEqual(['aramex', 'bosta', 'manual', 'mylerz', 'shipblu']);
  });

  it('iCarry is gone (ruling PROVIDERS-7)', () => {
    expect(CARRIER_CODES as readonly string[]).not.toContain('icarry');
  });
});

// ─── Carrier registry ─────────────────────────────────────────────────────────

describe('Carrier registry', () => {
  it('has one adapter per carrier code, each carrying its own code', () => {
    expect(Object.keys(CARRIER_REGISTRY).sort()).toEqual([...CARRIER_CODES].sort());
    for (const code of CARRIER_CODES) expect(CARRIER_REGISTRY[code].code).toBe(code);
  });

  it('every carrier implements the ShippingCarrierProvider interface', () => {
    for (const carrier of Object.values(CARRIER_REGISTRY)) {
      expect(typeof carrier.createShipment).toBe('function');
      expect(typeof carrier.trackShipment).toBe('function');
      expect(typeof carrier.cancelShipment).toBe('function');
      expect(typeof carrier.processWebhook).toBe('function');
      expect(typeof carrier.testConnection).toBe('function');
    }
  });

  it('declares only capabilities it implements', () => {
    for (const carrier of Object.values(CARRIER_REGISTRY)) {
      expect(!!carrier.quote, carrier.code).toBe(carrier.capabilities.quote);
      expect(!!carrier.getLabel, carrier.code).toBe(carrier.capabilities.label);
      // a webhook carrier must say how it is authenticated beyond the URL token or declare none
      if (!carrier.capabilities.webhooks)
        expect(carrier.webhookHeader, carrier.code).toBeUndefined();
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
