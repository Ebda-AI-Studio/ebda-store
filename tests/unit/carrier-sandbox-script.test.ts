/**
 * scripts/provider-sandbox-check.mjs for the shipping carriers: SANDBOX ONLY. The helper that
 * refuses a base-URL override pointing at a carrier's LIVE host must keep refusing, and every
 * adapter the script drives must exist under the catalog code it is registered by.
 */
import { describe, it, expect } from 'vitest';
import {
  CARRIER_ADAPTERS,
  LIVE_HOSTS,
  isLiveHost,
} from '../../scripts/lib/carrier-sandbox-check.mjs';
import { providersOfKind } from '@ebda/shared';

describe('carrier sandbox script', () => {
  it('covers exactly the API carriers of the catalog', () => {
    const api = providersOfKind('shipping')
      .filter(p => !p.manual)
      .map(p => p.code)
      .sort();
    expect(Object.keys(CARRIER_ADAPTERS).sort()).toEqual(api);
    expect(Object.keys(LIVE_HOSTS).sort()).toEqual(api);
  });

  it.each([
    ['bosta', 'https://app.bosta.co/api/v2'],
    ['bosta', 'https://APP.bosta.co'],
    ['shipblu', 'https://api.shipblu.com/api'],
    ['mylerz', 'https://integration.mylerz.net'],
    ['aramex', 'https://ws.aramex.net/ShippingAPI.V2'],
    ['aramex', 'not a url'],
  ])('refuses %s live host %s', (carrier, url) => {
    expect(isLiveHost(carrier, url)).toBe(true);
  });

  it.each([
    ['bosta', 'https://stg-app.bosta.co/api/v2'],
    ['shipblu', 'https://api.staging.shipblu.com/api'],
    ['mylerz', 'https://mylerz-staging.example.test'],
    ['aramex', 'https://ws.dev.aramex.net/ShippingAPI.V2'],
  ])('allows %s staging host %s', (carrier, url) => {
    expect(isLiveHost(carrier, url)).toBe(false);
  });
});
