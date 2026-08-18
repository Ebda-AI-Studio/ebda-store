import { describe, it, expect } from 'vitest';
import { zonesFromResponse } from '../../apps/web/src/hooks/useShippingZones';

describe('zonesFromResponse', () => {
  it('returns the zones on a well-formed success response', () => {
    expect(zonesFromResponse({ success: true, data: { zones: [{ id: 'z1' }] } })).toEqual([
      { id: 'z1' },
    ]);
  });

  it('returns an empty array when the merchant genuinely has no zones', () => {
    // Distinct from failure: [] means "configured nothing", null means "we do not know".
    expect(zonesFromResponse({ success: true, data: { zones: [] } })).toEqual([]);
  });

  it('fails on success:false', () => {
    expect(zonesFromResponse({ success: false, data: { zones: [{ id: 'z1' }] } })).toBeNull();
  });

  it('fails when zones is missing or not an array', () => {
    // Rendering an empty shipping page here would tell the shopper the merchant
    // ships nowhere, when in fact we failed to read the answer.
    expect(zonesFromResponse({ success: true, data: {} })).toBeNull();
    expect(zonesFromResponse({ success: true })).toBeNull();
    expect(zonesFromResponse({ success: true, data: { zones: 'nope' } })).toBeNull();
  });

  it('fails on absent or malformed bodies without throwing', () => {
    expect(zonesFromResponse(undefined)).toBeNull();
    expect(zonesFromResponse(null)).toBeNull();
    expect(zonesFromResponse('garbage')).toBeNull();
  });
});
