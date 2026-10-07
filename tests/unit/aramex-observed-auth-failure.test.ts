/**
 * The one Aramex answer we could OBSERVE rather than read about: on 2026-10-07 a read-only
 * `Location/FetchCountries` with a fake account against the live host (ws.aramex.net) answered
 * HTTP 200 with the body below. It settles two things the WSDLs and the (unreadable) manual do not:
 *
 *   1. FetchCountries DOES authenticate the ClientInfo (so it is a valid "Test connection": garbage
 *      credentials cannot pass the enable gate through it);
 *   2. a bad login is HTTP 200 + `HasErrors=true` + Notification `ERR75`, not a SOAP fault.
 *
 * The body is kept verbatim (it carries no secret: the credentials were fake).
 */
import { describe, it, expect } from 'vitest';
import { AramexCarrier } from '@api/services/carriers/aramex.carrier';

const OBSERVED = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><CountriesFetchingResponse xmlns="http://ws.aramex.net/ShippingAPI/v1/"><Transaction i:nil="true" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/><Notifications xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Notification><Code>ERR75</Code><Message>ClientInfo - Failed to login using Portal Service</Message></Notification></Notifications><HasErrors>true</HasErrors><Countries xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/></CountriesFetchingResponse></s:Body></s:Envelope>`;

const CREDS = {
  username: 'probe@example.invalid',
  password: 'secret-password-1',
  accountNumber: '000000',
  accountPin: '0',
  accountEntity: 'CAI',
  accountCountryCode: 'EG',
};

describe('Aramex Test connection against the observed bad-login answer', () => {
  it('reads ERR75 as bad credentials and never echoes the password', async () => {
    const calls: string[] = [];
    const carrier = new AramexCarrier({
      baseUrl: 'http://stub.test/ShippingAPI.V2',
      timeoutMs: 100,
      fetchImpl: async (url: string) => {
        calls.push(url);
        return new Response(OBSERVED, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      },
    });
    const r = await carrier.testConnection(CREDS, { settings: {} });
    expect(r).toMatchObject({ success: false, code: 'bad_credentials' });
    expect(JSON.stringify(r)).not.toContain(CREDS.password);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/Location/Service_1_0.svc');
  });
});
