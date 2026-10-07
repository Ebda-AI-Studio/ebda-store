/**
 * Aramex adapter vs the OFFICIAL WSDLs (SOAP 1.1, ws.aramex.net/ShippingAPI.V2, fetched
 * 2026-10-07). Element order is enforced by Aramex (xs:sequence), so the order of every request
 * is asserted here AND by the stub's own WSDL validator. Anything the WSDL does not define
 * (product types, report ids, status codes, EGP COD) is UNVERIFIED in the adapter.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { AramexCarrier, mapAramexStatus, parseXml } from '@api/services/carriers/aramex.carrier';
import { CarrierError } from '@api/services/carriers/types';
import { AramexStub, ARAMEX_NS, ARAMEX_STUB, validateAramexRequest } from '../stubs/aramex-stub';
import { shipmentRequest } from '../contract/shipping-carrier.contract';

const creds = ARAMEX_STUB.credentials;
const ctx = { settings: { codEgpConfirmed: true, productType: 'CDS' } };

const mk = (fetchImpl?: (u: string, i?: RequestInit) => Promise<Response>) => {
  const stub = new AramexStub();
  const carrier = new AramexCarrier({
    fetchImpl: fetchImpl ?? stub.fetch,
    baseUrl: ARAMEX_STUB.baseUrl,
    timeoutMs: 200,
  });
  return { stub, carrier };
};

const dom = (xml: string) => new new JSDOM('').window.DOMParser().parseFromString(xml, 'text/xml');
const names = (el: Element | undefined | null) =>
  Array.from(el?.children ?? []).map(c => c.localName);
const wrapperOf = (xml: string) => dom(xml).getElementsByTagNameNS('*', 'Body')[0].children[0];
const first = (el: Element, name: string) => el.getElementsByTagNameNS(ARAMEX_NS, name)[0];
const lastCall = (stub: AramexStub) => stub.log[stub.log.length - 1];

const bookOne = async (o: Parameters<typeof shipmentRequest>[0] = {}) => {
  const { stub, carrier } = mk();
  const out = await carrier.createShipment(creds, shipmentRequest(o), ctx);
  return {
    stub,
    carrier,
    out,
    xml: stub.log.find(l => l.action?.endsWith('/CreateShipments'))!.xml,
  };
};

describe('request element ORDER follows the WSDL sequences', () => {
  it('CreateShipments', async () => {
    const { stub, xml } = await bookOne({ codAmount: 12345 });
    const w = wrapperOf(xml);
    expect(w.localName).toBe('ShipmentCreationRequest');
    expect(names(w)).toEqual(['ClientInfo', 'Transaction', 'Shipments', 'LabelInfo']);
    expect(names(first(w, 'ClientInfo'))).toEqual([
      'UserName',
      'Password',
      'Version',
      'AccountNumber',
      'AccountPin',
      'AccountEntity',
      'AccountCountryCode',
      'Source',
    ]);
    expect(names(first(w, 'Transaction'))).toEqual([
      'Reference1',
      'Reference2',
      'Reference3',
      'Reference4',
      'Reference5',
    ]);
    const shipment = first(w, 'Shipment');
    expect(names(shipment)).toEqual([
      'Reference1',
      'Shipper',
      'Consignee',
      'ShippingDateTime',
      'DueDate',
      'Details',
    ]);
    expect(names(first(shipment, 'Details'))).toEqual([
      'Dimensions',
      'ActualWeight',
      'ChargeableWeight',
      'DescriptionOfGoods',
      'GoodsOriginCountry',
      'NumberOfPieces',
      'ProductGroup',
      'ProductType',
      'PaymentType',
      'PaymentOptions',
      'CashOnDeliveryAmount',
      'Services',
    ]);
    expect(names(first(shipment, 'Consignee'))).toEqual(['Reference1', 'PartyAddress', 'Contact']);
    expect(names(first(first(shipment, 'Consignee'), 'Contact'))).toEqual([
      'PersonName',
      'CompanyName',
      'PhoneNumber1',
      'PhoneNumber2',
      'CellPhone',
      'EmailAddress',
      'Type',
    ]);
    expect(names(first(first(shipment, 'Details'), 'ActualWeight'))).toEqual(['Unit', 'Value']);
    expect(names(first(first(shipment, 'Details'), 'CashOnDeliveryAmount'))).toEqual([
      'CurrencyCode',
      'Value',
    ]);
    expect(names(first(w, 'LabelInfo'))).toEqual(['ReportID', 'ReportType']);
    expect(stub.violations).toEqual([]);
  });

  it('PrintLabel, CalculateRate, TrackShipments, FetchCountries, CreatePickup', async () => {
    const { stub, carrier } = mk();
    const b = await carrier.createShipment(creds, shipmentRequest(), ctx);
    await carrier.getLabel(creds, b, ctx);
    await carrier.quote(
      creds,
      {
        pickupAddress: shipmentRequest().pickupAddress,
        deliveryAddress: shipmentRequest().deliveryAddress,
      },
      ctx
    );
    await carrier.trackShipment(creds, b.trackingNumber, ctx);
    expect(await carrier.testConnection(creds, ctx)).toEqual({ success: true });
    const when = new Date('2026-10-08T10:00:00Z');
    const pu = await carrier.createPickup(
      creds,
      {
        address: shipmentRequest().pickupAddress,
        pickupDate: when,
        readyTime: when,
        lastPickupTime: when,
        closingTime: when,
        shipments: 1,
      },
      ctx
    );
    expect(pu.pickupGuid).toMatch(/^[0-9a-f-]{36}$/);

    const by = (op: string) => wrapperOf(stub.log.find(l => l.action?.endsWith(`/${op}`))!.xml);
    expect(names(by('PrintLabel'))).toEqual([
      'ClientInfo',
      'Transaction',
      'ShipmentNumber',
      'ProductGroup',
      'OriginEntity',
      'LabelInfo',
    ]);
    const rate = by('CalculateRate');
    expect(names(rate)).toEqual([
      'ClientInfo',
      'Transaction',
      'OriginAddress',
      'DestinationAddress',
      'ShipmentDetails',
      'PreferredCurrencyCode',
    ]);
    // the rate Address makes Line1..3, City, PostCode and CountryCode schema-required
    expect(names(first(rate, 'OriginAddress'))).toEqual([
      'Line1',
      'Line2',
      'Line3',
      'City',
      'StateOrProvinceCode',
      'PostCode',
      'CountryCode',
    ]);
    expect(names(by('TrackShipments'))).toEqual([
      'ClientInfo',
      'Transaction',
      'Shipments',
      'GetLastTrackingUpdateOnly',
    ]);
    const track = by('TrackShipments');
    expect(first(track, 'Shipments').children[0].namespaceURI).toBe(
      'http://schemas.microsoft.com/2003/10/Serialization/Arrays'
    );
    expect(names(by('FetchCountries'))).toEqual(['ClientInfo', 'Transaction']);
    expect(names(by('CreatePickup'))).toEqual(['ClientInfo', 'Transaction', 'Pickup', 'LabelInfo']);
    expect(stub.violations).toEqual([]);
  });

  it('the stub really rejects a mis-ordered or incomplete request', () => {
    const wrap = (inner: string) =>
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><CountriesFetchingRequest xmlns="${ARAMEX_NS}">${inner}</CountriesFetchingRequest></s:Body></s:Envelope>`;
    const ci =
      '<ClientInfo><UserName>a</UserName><Password>b</Password><Version>v1.0</Version><AccountNumber>1</AccountNumber><AccountPin>2</AccountPin><AccountEntity>CAI</AccountEntity><AccountCountryCode>EG</AccountCountryCode></ClientInfo>';
    const tx =
      '<Transaction><Reference1/><Reference2/><Reference3/><Reference4/><Reference5/></Transaction>';
    expect(validateAramexRequest('Location', wrap(ci + tx))).toEqual([]);
    expect(validateAramexRequest('Location', wrap(tx + ci)).join()).toMatch(/order/);
    expect(
      validateAramexRequest(
        'Location',
        wrap(ci + '<Transaction><Reference1/></Transaction>')
      ).join()
    ).toMatch(/Reference2/);
    expect(
      validateAramexRequest(
        'Location',
        wrap(ci.replace('<Password>b</Password>', '') + tx).trim()
      ).join()
    ).toMatch(/Password/);
  });
});

describe('transport: endpoint, SOAPAction, namespace', () => {
  it('posts text/xml to <base>/<Service>/Service_1_0.svc with the quoted per-operation SOAPAction', async () => {
    const { stub, carrier } = mk();
    const b = await carrier.createShipment(creds, shipmentRequest(), ctx);
    await carrier.getLabel(creds, b, ctx);
    await carrier.trackShipment(creds, b.trackingNumber, ctx);
    await carrier.quote(
      creds,
      {
        pickupAddress: shipmentRequest().pickupAddress,
        deliveryAddress: shipmentRequest().deliveryAddress,
      },
      ctx
    );
    await carrier.testConnection(creds, ctx);
    const seen = stub.log.map(l => [l.path, l.action, l.contentType]);
    const A = 'http://ws.aramex.net/ShippingAPI/v1/Service_1_0/';
    expect(seen).toEqual([
      ['/Shipping/Service_1_0.svc', `${A}CreateShipments`, 'text/xml; charset=utf-8'],
      ['/Shipping/Service_1_0.svc', `${A}PrintLabel`, 'text/xml; charset=utf-8'],
      ['/Tracking/Service_1_0.svc', `${A}TrackShipments`, 'text/xml; charset=utf-8'],
      ['/RateCalculator/Service_1_0.svc', `${A}CalculateRate`, 'text/xml; charset=utf-8'],
      ['/Location/Service_1_0.svc', `${A}FetchCountries`, 'text/xml; charset=utf-8'],
    ]);
    for (const l of stub.log) {
      expect(wrapperOf(l.xml).namespaceURI).toBe(ARAMEX_NS);
      expect(l.xml).toContain('xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"');
    }
  });

  it('sandbox mode picks the dev host, live the live host', async () => {
    const urls: string[] = [];
    const spy = async (u: string) => {
      urls.push(u);
      return new Response('<x/>', { status: 200 });
    };
    // no baseUrl override: the real hosts, through a spy transport
    const prev = process.env.ARAMEX_BASE_URL;
    delete process.env.ARAMEX_BASE_URL;
    try {
      const c = new AramexCarrier({ fetchImpl: spy, timeoutMs: 200 });
      await c.testConnection(creds, { settings: { sandbox: true } });
      await c.testConnection(creds, { settings: {} });
    } finally {
      if (prev !== undefined) process.env.ARAMEX_BASE_URL = prev;
    }
    expect(urls).toEqual([
      'https://ws.dev.aramex.net/ShippingAPI.V2/Location/Service_1_0.svc',
      'https://ws.aramex.net/ShippingAPI.V2/Location/Service_1_0.svc',
    ]);
  });
});

describe('XML injection', () => {
  it('a customer name with markup stays text, and & / quotes / control chars are handled', async () => {
    const evil = '</Name><Evil/>';
    const { stub, xml } = await bookOne({
      deliveryAddress: {
        ...shipmentRequest().deliveryAddress,
        name: `${evil} & Co "x" 'y'\u0007\u0000`,
        line1: '<script>alert(1)</script>',
      },
      notes: ']]><Evil2/>',
    });
    const doc = dom(xml);
    expect(doc.getElementsByTagName('Evil').length).toBe(0);
    expect(doc.getElementsByTagName('Evil2').length).toBe(0);
    expect(doc.getElementsByTagName('script').length).toBe(0);
    const consignee = first(doc.documentElement, 'Consignee');
    expect(first(consignee, 'PersonName').textContent).toBe(`${evil} & Co "x" 'y'`);
    expect(xml).toContain('&lt;/Name&gt;&lt;Evil/&gt; &amp; Co');
    expect(xml).not.toMatch(/[\u0000-\u0008]/);
    expect(stub.violations).toEqual([]);
  });

  it('the tracking number cannot inject either', async () => {
    const { stub, carrier } = mk();
    await carrier
      .trackShipment(creds, '1</arr:string><Evil/>', ctx)
      .catch((e: CarrierError) => expect(e.code).toBe('CARRIER_REJECTED'));
    expect(dom(lastCall(stub).xml).getElementsByTagName('Evil').length).toBe(0);
  });
});

describe('COD', () => {
  it('is refused without codEgpConfirmed, with nothing sent', async () => {
    const { stub, carrier } = mk();
    for (const settings of [
      { productType: 'CDS' },
      { productType: 'CDS', codEgpConfirmed: 'true' },
    ]) {
      await expect(
        carrier.createShipment(creds, shipmentRequest({ codAmount: 5000 }), { settings })
      ).rejects.toMatchObject({ code: 'COD_NOT_SUPPORTED' });
    }
    expect(stub.requests).toHaveLength(0);
  });

  it.each([
    [1, '0.01'],
    [29, '0.29'],
    [12345, '123.45'],
    [999999, '9999.99'],
  ])('%i piastres is sent as CashOnDeliveryAmount EGP %s with the CODS service', async (p, egp) => {
    const { stub, xml } = await bookOne({ codAmount: p });
    const cod = first(dom(xml).documentElement, 'CashOnDeliveryAmount');
    expect(first(cod, 'CurrencyCode').textContent).toBe('EGP');
    expect(first(cod, 'Value').textContent).toBe(egp);
    expect(first(dom(xml).documentElement, 'Services').textContent).toBe('CODS');
    expect([...stub.parcels.values()][0].codMinor).toBe(p);
  });

  it('prepaid sends no COD element and no Services', async () => {
    const { xml } = await bookOne();
    expect(xml).not.toContain('CashOnDeliveryAmount');
    expect(xml).not.toContain('<Services>');
  });
});

describe('failures', () => {
  it('a missing product type is CARRIER_MISCONFIGURED and sends nothing', async () => {
    const { stub, carrier } = mk();
    const err = await carrier
      .createShipment(creds, shipmentRequest(), { settings: {} })
      .catch(e => e);
    expect(err).toMatchObject({ code: 'CARRIER_MISCONFIGURED' });
    expect(err.message).toMatch(/product type/i);
    expect(stub.requests).toHaveLength(0);
  });

  it('HasErrors at the response level -> CARRIER_REJECTED with the Notification', async () => {
    const { stub, carrier } = mk();
    stub.errorNext = 'Consignee city is not serviced';
    const err = await carrier.createShipment(creds, shipmentRequest(), ctx).catch(e => e);
    expect(err).toMatchObject({ code: 'CARRIER_REJECTED' });
    expect(err.message).toContain('[ERR99] Consignee city is not serviced');
    expect(stub.parcels.size).toBe(0);
  });

  it('HasErrors on the ProcessedShipment -> CARRIER_REJECTED with its Notification', async () => {
    const { stub, carrier } = mk();
    stub.failNextShipment = 'Invalid product type';
    const err = await carrier.createShipment(creds, shipmentRequest(), ctx).catch(e => e);
    expect(err).toMatchObject({ code: 'CARRIER_REJECTED' });
    expect(err.message).toContain('[ERR52] Invalid product type');
    // a rejected request is not cached: the fixed retry books
    const ok = await carrier.createShipment(creds, shipmentRequest(), ctx);
    expect(ok.trackingNumber).toMatch(/^ARX/);
  });

  it('a very long notification is truncated', async () => {
    const { stub, carrier } = mk();
    stub.errorNext = 'x'.repeat(5000);
    const err = await carrier.createShipment(creds, shipmentRequest(), ctx).catch(e => e);
    expect(err.message.length).toBeLessThan(500);
  });

  it('SOAP Faults: a server fault is retryable, a credentials fault is misconfigured', async () => {
    const { stub, carrier } = mk();
    stub.faultNext = 'The server was unable to process the request';
    const a = await carrier.createShipment(creds, shipmentRequest(), ctx).catch(e => e);
    expect(a).toMatchObject({ code: 'CARRIER_UNAVAILABLE', retryable: true });
    stub.faultNext = 'The security token could not be authenticated or authorized';
    const b = await carrier.createShipment(creds, shipmentRequest(), ctx).catch(e => e);
    expect(b).toMatchObject({ code: 'CARRIER_MISCONFIGURED' });
  });

  it('a bare HTTP 500 / gateway page is CARRIER_UNAVAILABLE', async () => {
    const { carrier } = mk(async () => new Response('<html>Bad gateway</html>', { status: 500 }));
    await expect(carrier.createShipment(creds, shipmentRequest(), ctx)).rejects.toMatchObject({
      code: 'CARRIER_UNAVAILABLE',
    });
  });

  it('401/403 are credential problems', async () => {
    const { carrier } = mk(async () => new Response('no', { status: 401 }));
    await expect(
      carrier.getLabel(creds, { carrierShipmentId: 'A', trackingNumber: 'A' }, ctx)
    ).rejects.toMatchObject({
      code: 'CARRIER_MISCONFIGURED',
    });
  });

  it('bad credentials: testConnection says bad_credentials and no secret is in any message', async () => {
    const { stub, carrier } = mk();
    stub.rejectAuth = true;
    const out = await carrier.testConnection(creds, ctx);
    expect(out).toEqual({
      success: false,
      code: 'bad_credentials',
      error: 'Aramex refused the credentials',
    });
    stub.rejectAuth = false;
    // a fault that ECHOES the password must not leak it
    stub.faultNext = `boom for ${creds.password} / ${creds.accountPin}`;
    const t2 = await carrier.testConnection(creds, ctx);
    expect(t2.code).toBe('unreachable');
    expect(JSON.stringify(t2)).not.toContain(creds.password);
    expect(JSON.stringify(t2)).not.toContain(creds.accountPin);
    const e = await carrier
      .createShipment({ ...creds, password: 'wrong-pw' }, shipmentRequest(), ctx)
      .catch(x => x);
    expect(e.code).toBe('CARRIER_MISCONFIGURED');
    expect(e.message).not.toContain('wrong-pw');
  });

  it('testConnection: outage is unreachable, other refusals are unknown', async () => {
    const { stub, carrier } = mk();
    stub.injectNextCall('unavailable');
    expect((await carrier.testConnection(creds, ctx)).code).toBe('unreachable');
    stub.errorNext = 'Something odd';
    const out = await carrier.testConnection(creds, ctx);
    expect(out).toMatchObject({ success: false, code: 'unknown' });
  });
});

describe('cancel, webhook', () => {
  it('has no cancel API: not_cancellable with NO network call', async () => {
    const { stub, carrier } = mk();
    const r = await carrier.cancelShipment(creds, 'ARX000000001', ctx);
    expect(r.status).toBe('not_cancellable');
    expect(r.message).toMatch(/Aramex support/);
    expect(r.message).toMatch(/force-cancel/);
    expect(stub.requests).toHaveLength(0);
  });

  it('no push exists: processWebhook is always null', () => {
    const { carrier } = mk();
    expect(carrier.processWebhook({ WaybillNumber: 'X', UpdateCode: 'SH050' }, {})).toBeNull();
    expect(carrier.capabilities).toMatchObject({
      webhooks: false,
      polling: true,
      cod: 'unconfirmed',
    });
  });
});

describe('quote and labels', () => {
  const addrs = {
    pickupAddress: shipmentRequest().pickupAddress,
    deliveryAddress: shipmentRequest().deliveryAddress,
  };

  it('EGP only: converts exactly and refuses any other currency', async () => {
    const { stub, carrier } = mk();
    stub.quoteValue = '62.5';
    expect((await carrier.quote(creds, addrs, ctx)).amountPiastres).toBe(6250);
    stub.quoteValue = '0.29';
    expect((await carrier.quote(creds, addrs, ctx)).amountPiastres).toBe(29);
    stub.quoteCurrency = 'USD';
    await expect(carrier.quote(creds, addrs, ctx)).rejects.toMatchObject({
      code: 'CARRIER_REJECTED',
    });
  });

  it('a hosted LabelURL is returned as url; inline LabelFileContents as pdfBase64', async () => {
    const { carrier } = mk();
    const lbl = await carrier
      .getLabel(creds, { carrierShipmentId: 'x', trackingNumber: 'x' }, ctx)
      .catch(e => e);
    expect(lbl).toMatchObject({ code: 'CARRIER_REJECTED' }); // unknown shipment on the stub
    const body = (inner: string) =>
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><LabelPrintingResponse xmlns="${ARAMEX_NS}"><Notifications/><HasErrors>false</HasErrors>${inner}</LabelPrintingResponse></s:Body></s:Envelope>`;
    const { carrier: c2 } = mk(
      async () =>
        new Response(
          body(
            '<ShipmentLabel><LabelURL/><LabelFileContents>JVBERi0x\nLjQ=</LabelFileContents></ShipmentLabel>'
          )
        )
    );
    expect(await c2.getLabel(creds, { carrierShipmentId: 'x', trackingNumber: 'x' }, ctx)).toEqual({
      pdfBase64: 'JVBERi0xLjQ=',
    });
    const { carrier: c3 } = mk(
      async () =>
        new Response(
          body(
            '<ShipmentLabel><LabelURL>javascript:alert(1)</LabelURL><LabelFileContents/></ShipmentLabel>'
          )
        )
    );
    await expect(
      c3.getLabel(creds, { carrierShipmentId: 'x', trackingNumber: 'x' }, ctx)
    ).rejects.toMatchObject({ code: 'CARRIER_UNAVAILABLE' });
  });
});

describe('tracking', () => {
  it('NonExistingWaybills -> CARRIER_REJECTED unknown waybill', async () => {
    const { carrier } = mk();
    const err = await carrier.trackShipment(creds, 'NOPE123', ctx).catch(e => e);
    expect(err).toMatchObject({ code: 'CARRIER_REJECTED' });
    expect(err.message).toMatch(/unknown waybill/);
  });

  it('reads the KeyValue dictionary, oldest first, newest decides', async () => {
    const { stub, carrier } = mk();
    const b = await carrier.createShipment(creds, shipmentRequest(), ctx);
    stub.advance(b.trackingNumber, 'picked_up');
    stub.advance(b.trackingNumber, 'out_for_delivery');
    const t = await carrier.trackShipment(creds, b.trackingNumber, ctx);
    expect(t.status).toBe('out_for_delivery');
    expect(t.statusHistory.map(h => h.status)).toEqual([
      'created',
      'picked_up',
      'out_for_delivery',
    ]);
    expect(t.statusHistory[0].location).toBe('Cairo');
  });

  it('an event with no usable text or known code keeps the last known status', async () => {
    const xml = (events: string) =>
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ShipmentTrackingResponse xmlns="${ARAMEX_NS}" xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><Notifications/><HasErrors>false</HasErrors><TrackingResults><a:KeyValueOfstringArrayOfTrackingResultmFAkxlpY><a:Key>W1</a:Key><a:Value>${events}</a:Value></a:KeyValueOfstringArrayOfTrackingResultmFAkxlpY></TrackingResults><NonExistingWaybills/></ShipmentTrackingResponse></s:Body></s:Envelope>`;
    const ev = (code: string, desc: string, at: string) =>
      `<TrackingResult><WaybillNumber>W1</WaybillNumber><UpdateCode>${code}</UpdateCode><UpdateDescription>${desc}</UpdateDescription><UpdateDateTime>${at}</UpdateDateTime><UpdateLocation/></TrackingResult>`;
    const { carrier } = mk(
      async () =>
        new Response(
          xml(
            ev('ZZ999', '', '2026-10-07T12:00:00') + // unknown, no text -> keeps out_for_delivery
              ev('ZZ001', 'Out for delivery', '2026-10-07T10:00:00') +
              ev('ZZ002', 'Arrived at facility', '2026-10-07T08:00:00')
          )
        )
    );
    const t = await carrier.trackShipment(creds, 'W1', ctx);
    expect(t.statusHistory.map(h => h.status)).toEqual([
      'in_transit',
      'out_for_delivery',
      'out_for_delivery',
    ]);
    expect(t.status).toBe('out_for_delivery');
  });

  it('UNVERIFIED description heuristic table', () => {
    const cases: Array<[string, string, string]> = [
      ['X', 'Out for delivery', 'out_for_delivery'],
      ['X', 'Shipment delivered', 'delivered'],
      ['X', 'Delivery attempt unsuccessful', 'failed'],
      ['X', 'Returned to shipper', 'returned'],
      ['X', 'Shipment picked up', 'picked_up'],
      ['X', 'Shipment cancelled', 'cancelled'],
      ['X', 'Arrived at hub', 'in_transit'], // text that matches nothing
    ];
    for (const [code, d, want] of cases) expect(mapAramexStatus(code, d)).toBe(want);
    // empty text: from-memory code table, else the previous status
    expect(mapAramexStatus('SH050', '')).toBe('delivered');
    expect(mapAramexStatus('NOPE', '', 'picked_up')).toBe('picked_up');
    expect(mapAramexStatus('NOPE', '')).toBe('in_transit');
  });
});

describe('the tolerant XML reader', () => {
  it('handles prefixes, CDATA, entities, comments, self-closing, nil and a DOCTYPE without expanding it', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]><!-- c --><p:A xmlns:p="u"><p:B>1 &amp; 2 &#65; &lt;x&gt; &a;</p:B><C><![CDATA[<raw>]]></C><D/><E xsi:nil="true"/></p:A>`
    );
    const a = root.children[0];
    expect(a.name).toBe('A');
    expect(a.children.map(c => c.name)).toEqual(['B', 'C', 'D', 'E']);
    expect(a.children[0].text).toBe('1 & 2 A <x> &a;');
    expect(a.children[1].text).toBe('<raw>');
    expect(a.children[3].nil).toBe(true);
  });
});
