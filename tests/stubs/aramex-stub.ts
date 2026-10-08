/**
 * A local stand-in for Aramex's four SOAP 1.1 services (Shipping, RateCalculator, Tracking,
 * Location), SP7. The adapter is given `stub.fetch` as its transport.
 *
 * Unlike a permissive fake it VALIDATES every request against the element ORDER and the
 * schema-required elements of the live WSDLs (xs:sequence is enforced by Aramex): the tables
 * below were generated from ws.aramex.net/ShippingAPI.V2/<Service>/Service_1_0.svc?singleWsdl.
 * A request that violates them gets a SOAP Fault and is recorded in `violations`, so a
 * mis-ordered adapter fails the contract tests. Answers are official-shaped: HasErrors /
 * Notifications, ProcessedShipment, ShipmentLabel, the TrackingResults KeyValue dictionary,
 * Countries. Not idempotent on create (Aramex has no idempotency key).
 */
import { JSDOM } from 'jsdom';
import type { ShipmentStatus } from '@api/services/carriers/types';
import { FaultGate, type StubFault } from './stub-common';
import { egpToPiastres } from '@api/lib/carrier-http';

export const ARAMEX_NS = 'http://ws.aramex.net/ShippingAPI/v1/';
export const ARAMEX_ARR_NS = 'http://schemas.microsoft.com/2003/10/Serialization/Arrays';

export const ARAMEX_STUB = {
  baseUrl: 'http://aramex.stub/ShippingAPI.V2',
  credentials: {
    accountNumber: '1234567',
    accountPin: '654321',
    accountEntity: 'CAI',
    accountCountryCode: 'EG',
    username: 'tester@example.com',
    password: 'pw-s3cret',
  },
};

/**
 * Per service: type -> ordered children as "Name[*][:Type]" (* = schema-required, :Type = a
 * complex child). `ArrayOfX` types hold one repeated child. Generated from the WSDLs.
 */
export const ARAMEX_SCHEMA: Record<string, Record<string, string>> = {
  Shipping: {
    ShipmentCreationRequest:
      'ClientInfo:ClientInfo Transaction:Transaction Shipments:ArrayOfShipment LabelInfo:LabelInfo CommercialInvoiceReportID',
    ClientInfo:
      'UserName* Password* Version AccountNumber* AccountPin* AccountEntity* AccountCountryCode* Source PreferredLanguageCode',
    Transaction: 'Reference1* Reference2* Reference3* Reference4* Reference5*',
    ArrayOfShipment: 'Shipment:Shipment',
    Shipment:
      'Reference1 Reference2 Reference3 Shipper*:Party Consignee*:Party ThirdParty:Party ShippingDateTime* DueDate Comments PickupLocation OperationsInstructions AccountingInstrcutions Details*:ShipmentDetails Attachments:ArrayOfAttachment ForeignHAWB TransportType_x0020_ PickupGUID Number ScheduledDelivery:ScheduledDelivery IsLocalized',
    Party: 'Reference1 Reference2 AccountNumber PartyAddress:Address Contact*:Contact PudoID',
    Address:
      'Line1 Line2 Line3 City StateOrProvinceCode PostCode CountryCode Longitude Latitude BuildingNumber BuildingName Floor Apartment POBox Description AddressShortCode',
    Contact:
      'Department PersonName* Title CompanyName PhoneNumber1* PhoneNumber1Ext PhoneNumber2* PhoneNumber2Ext FaxNumber CellPhone EmailAddress Type*',
    ShipmentDetails:
      'Dimensions*:Dimensions ActualWeight*:Weight ChargeableWeight*:Weight DescriptionOfGoods* GoodsOriginCountry* NumberOfPieces* ProductGroup ProductType* PaymentType* PaymentOptions* CustomsValueAmount:Money CashOnDeliveryAmount:Money InsuranceAmount:Money CashAdditionalAmount:Money CashAdditionalAmountDescription CollectAmount:Money Services Items:ArrayOfShipmentItem DeliveryInstructions:DeliveryInstructions AdditionalProperties:ArrayOfAdditionalProperty ContainsDangerousGoods PieceDimensions:ArrayOfDimensions IsTrue',
    Dimensions:
      'Length* Width* Height* ActualWeight:Weight ChargeableWeight:Weight NumberOfPieces Unit* VolumetricWeight:Weight',
    Weight: 'Unit* Value*',
    Money: 'CurrencyCode* Value*',
    ArrayOfShipmentItem: 'ShipmentItem:ShipmentItem',
    ShipmentItem:
      'PackageType* Quantity* Weight*:Weight Comments Reference PiecesDimensions:ArrayOfDimensions CommodityCode GoodsDescription CountryOfOrigin CustomsValue:Money ContainerNumber Reference1 Reference2 Reference3 Reference4 Reference5 ProviderHSCode',
    ArrayOfDimensions: 'Dimensions:Dimensions',
    DeliveryInstructions: 'Option* Reference*',
    ArrayOfAdditionalProperty: 'AdditionalProperty:AdditionalProperty',
    AdditionalProperty: 'CategoryName* Name* Value*',
    ArrayOfAttachment: 'Attachment:Attachment',
    Attachment: 'FileName* FileExtension* FileContents FileContentsBase64 FileType',
    ScheduledDelivery:
      'PreferredDeliveryDate PreferredDeliveryTimeFrame_x0020_ PreferredDeliveryTime',
    LabelInfo: 'ReportID* ReportType*',
    LabelPrintingRequest:
      'ClientInfo:ClientInfo Transaction:Transaction ShipmentNumber ProductGroup OriginEntity LabelInfo:LabelInfo',
    PickupCreationRequest:
      'ClientInfo:ClientInfo Transaction:Transaction Pickup:Pickup LabelInfo:LabelInfo',
    Pickup:
      'PickupAddress*:Address PickupContact*:Contact PickupLocation* PickupDate* ReadyTime* LastPickupTime* ClosingTime* Comments* Reference1 Reference2 Vehicle* Shipments:ArrayOfShipment PickupItems*:ArrayOfPickupItemDetail Status ExistingShipments:ArrayOfExistingShipment Branch RouteCode Dispatcher',
    ArrayOfPickupItemDetail: 'PickupItemDetail:PickupItemDetail',
    PickupItemDetail:
      'ProductGroup* ProductType* NumberOfShipments* PackageType* Payment* ShipmentWeight*:Weight ShipmentVolume*:Volume NumberOfPieces* CashAmount*:Money ExtraCharges*:Money ShipmentDimensions*:Dimensions Comments*',
    Volume: 'Unit* Value*',
    ArrayOfExistingShipment: 'ExistingShipment:ExistingShipment',
    // Shipping WSDL: PickupCancelationRequest (ClientInfo, Transaction, PickupGUID, Comments).
    PickupCancelationRequest: 'ClientInfo:ClientInfo Transaction:Transaction PickupGUID Comments',
    ExistingShipment: 'Number* OriginEntity* ProductGroup*',
  },
  RateCalculator: {
    RateCalculatorRequest:
      'ClientInfo:ClientInfo Transaction:Transaction OriginAddress:Address DestinationAddress:Address ShipmentDetails:ShipmentDetails PreferredCurrencyCode',
    ClientInfo:
      'UserName* Password* Version* AccountNumber* AccountPin* AccountEntity* AccountCountryCode* Source PreferredLanguageCode',
    Transaction: 'Reference1* Reference2* Reference3* Reference4* Reference5*',
    Address:
      'Line1* Line2* Line3* City* StateOrProvinceCode PostCode* CountryCode* Longitude Latitude BuildingNumber BuildingName Floor Apartment POBox Description AddressShortCode',
    ShipmentDetails:
      'Dimensions*:Dimensions ActualWeight*:Weight ChargeableWeight*:Weight DescriptionOfGoods* GoodsOriginCountry* NumberOfPieces* ProductGroup* ProductType* PaymentType* PaymentOptions* CustomsValueAmount:Money CashOnDeliveryAmount:Money InsuranceAmount:Money CashAdditionalAmount:Money CashAdditionalAmountDescription CollectAmount:Money Services Items:ArrayOfShipmentItem DeliveryInstructions:DeliveryInstructions AdditionalProperties:ArrayOfAdditionalProperty ContainsDangerousGoods PieceDimensions:ArrayOfDimensions IsTrue',
    Dimensions:
      'Length* Width* Height* ActualWeight:Weight ChargeableWeight:Weight NumberOfPieces Unit* VolumetricWeight:Weight',
    Weight: 'Unit* Value*',
    Money: 'CurrencyCode* Value*',
    ArrayOfShipmentItem: 'ShipmentItem:ShipmentItem',
    ShipmentItem:
      'PackageType* Quantity* Weight*:Weight Comments Reference PiecesDimensions:ArrayOfDimensions CommodityCode GoodsDescription CountryOfOrigin CustomsValue:Money ContainerNumber Reference1 Reference2 Reference3 Reference4 Reference5',
    ArrayOfDimensions: 'Dimensions:Dimensions',
    DeliveryInstructions: 'Option* Reference*',
    ArrayOfAdditionalProperty: 'AdditionalProperty:AdditionalProperty',
    AdditionalProperty: 'CategoryName* Name* Value*',
  },
  Tracking: {
    ShipmentTrackingRequest:
      'ClientInfo:ClientInfo Transaction:Transaction Shipments:ArrayOfstring GetLastTrackingUpdateOnly GetUpdateTimeZone GetReferenceNumber',
    ClientInfo:
      'UserName* Password* Version* AccountNumber* AccountPin* AccountEntity* AccountCountryCode* Source PreferredLanguageCode',
    Transaction: 'Reference1* Reference2* Reference3* Reference4* Reference5*',
    ArrayOfstring: 'string',
  },
  Location: {
    CountriesFetchingRequest: 'ClientInfo:ClientInfo Transaction:Transaction',
    ClientInfo:
      'UserName* Password* Version* AccountNumber* AccountPin* AccountEntity* AccountCountryCode* Source PreferredLanguageCode',
    Transaction: 'Reference1* Reference2* Reference3* Reference4* Reference5*',
  },
};

type Entry = { name: string; req: boolean; type?: string };
const parsed = new Map<string, Entry[]>();
function entriesOf(service: string, type: string): Entry[] | undefined {
  const key = `${service}.${type}`;
  let e = parsed.get(key);
  if (!e) {
    const dsl = ARAMEX_SCHEMA[service]?.[type];
    if (dsl === undefined) return undefined;
    e = dsl
      .split(' ')
      .filter(Boolean)
      .map(tok => {
        const [n, ty] = tok.split(':');
        return { name: n.replace('*', ''), req: n.endsWith('*'), type: ty };
      });
    parsed.set(key, e);
  }
  return e;
}

const parseXml = (xml: string): Document | null => {
  const doc = new new JSDOM('').window.DOMParser().parseFromString(xml, 'text/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
};

function validate(service: string, type: string, node: Element, path: string, out: string[]): void {
  const entries = entriesOf(service, type);
  if (!entries) return;
  const children = Array.from(node.children);
  if (type.startsWith('ArrayOf')) {
    for (const c of children) {
      const expectNs = type === 'ArrayOfstring' ? ARAMEX_ARR_NS : ARAMEX_NS;
      if (c.localName !== entries[0].name || c.namespaceURI !== expectNs) {
        out.push(`${path}: unexpected <${c.localName}> in ${type}`);
      } else if (entries[0].type)
        validate(service, entries[0].type, c, `${path}/${c.localName}`, out);
    }
    return;
  }
  let idx = 0;
  for (const c of children) {
    if (c.namespaceURI !== ARAMEX_NS)
      out.push(`${path}/${c.localName}: wrong namespace ${c.namespaceURI}`);
    const at = entries.findIndex((e, i) => i >= idx && e.name === c.localName);
    if (at === -1) {
      const known = entries.some(e => e.name === c.localName);
      out.push(
        known
          ? `${path}/${c.localName}: out of schema order (or repeated)`
          : `${path}/${c.localName}: not in the schema of ${type}`
      );
      continue;
    }
    for (let k = idx; k < at; k++) {
      if (entries[k].req)
        out.push(`${path}: required <${entries[k].name}> missing before <${c.localName}>`);
    }
    idx = at + 1;
    const ty = entries[at].type;
    if (ty) validate(service, ty, c, `${path}/${c.localName}`, out);
    else if (c.children.length) out.push(`${path}/${c.localName}: leaf element has children`);
  }
  for (let k = idx; k < entries.length; k++) {
    if (entries[k].req) out.push(`${path}: required <${entries[k].name}> missing`);
  }
}

/** Violations of the WSDL contract in one SOAP request (empty = valid). */
export function validateAramexRequest(service: string, xml: string): string[] {
  const doc = parseXml(xml);
  if (!doc) return ['request is not well-formed XML'];
  const env = doc.documentElement;
  const body = env.localName === 'Envelope' ? env.getElementsByTagNameNS('*', 'Body')[0] : null;
  const wrapper = body?.children[0];
  if (!wrapper) return ['no SOAP Body request element'];
  const out: string[] = [];
  if (wrapper.namespaceURI !== ARAMEX_NS) out.push(`${wrapper.localName}: wrong namespace`);
  if (!entriesOf(service, wrapper.localName)) {
    return [`${wrapper.localName}: not a request of ${service}`];
  }
  validate(service, wrapper.localName, wrapper, wrapper.localName, out);
  return out;
}

const OPERATION_OF: Record<string, [string, string]> = {
  ShipmentCreationRequest: ['Shipping', 'CreateShipments'],
  LabelPrintingRequest: ['Shipping', 'PrintLabel'],
  PickupCreationRequest: ['Shipping', 'CreatePickup'],
  PickupCancelationRequest: ['Shipping', 'CancelPickup'],
  RateCalculatorRequest: ['RateCalculator', 'CalculateRate'],
  ShipmentTrackingRequest: ['Tracking', 'TrackShipments'],
  CountriesFetchingRequest: ['Location', 'FetchCountries'],
};

// [UpdateCode, UpdateDescription] per status; descriptions are what the adapter's heuristic reads.
const EVENT_FOR: Record<ShipmentStatus, [string, string]> = {
  created: ['SH005', 'Shipment data received'],
  picked_up: ['SH010', 'Picked up from shipper'],
  in_transit: ['SH020', 'Arrived at sorting hub'],
  out_for_delivery: ['SH040', 'Out for delivery'],
  delivered: ['SH050', 'Delivered'],
  failed: ['SH060', 'Delivery attempt unsuccessful'],
  returned: ['SH070', 'Returned to shipper'],
  cancelled: ['SH080', 'Shipment cancelled'],
};

export interface AramexParcel {
  waybill: string;
  reference: string;
  /** The COD the adapter sent, verbatim. */
  codValue: number | null;
  codCurrency: string | null;
  codMinor: number;
  /** Details/Services as sent. */
  services: string | null;
  updates: Array<{ UpdateCode: string; UpdateDescription: string; UpdateDateTime: string }>;
  pickedUp: boolean;
}

export interface AramexLoggedRequest {
  path: string;
  service: string;
  action: string | undefined;
  contentType: string | undefined;
  xml: string;
}

const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const txt = (doc: Document | Element, name: string): string =>
  (doc as Element).getElementsByTagNameNS?.(ARAMEX_NS, name)[0]?.textContent ?? '';

export class AramexStub {
  readonly faults = new FaultGate();
  readonly parcels = new Map<string, AramexParcel>();
  readonly requests: Array<{ path: string; action?: string }> = [];
  /** Full request log (raw XML + headers) for assertions on the wire format. */
  readonly log: AramexLoggedRequest[] = [];
  /** WSDL-contract violations found in requests so far (must stay empty). */
  readonly violations: string[] = [];
  historyOrder: 'asc' | 'desc' = 'desc';
  /** Currency the rate calculator quotes in. */
  quoteCurrency = 'EGP';
  quoteValue = '62.5';
  rejectAuth = false;
  /** Answer the next CreateShipments with ProcessedShipment.HasErrors = true. */
  failNextShipment: string | null = null;
  /** Answer the next call with a SOAP Fault (HTTP 500) carrying this text. */
  faultNext: string | null = null;
  /** Answer the next call with a response-level HasErrors + this notification message. */
  errorNext: string | null = null;
  pickups = 0;
  /** GUIDs of pickups CancelPickup has cancelled (a second cancel is refused). */
  readonly cancelledPickups = new Set<string>();
  // Carrier events must be NEWER than the shipment's own `created` history entry (stamped at
  // booking, i.e. now) or mergeTracking ignores them as stale. Start ahead of "now" instead.
  private clock = Date.now() + 6 * 3_600_000;

  private soap(status: number, inner: string): Response {
    return new Response(
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`,
      { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } }
    );
  }
  private fault(status: number, code: string, message: string): Response {
    return this.soap(
      status,
      `<s:Fault><faultcode>s:${code}</faultcode><faultstring xml:lang="en-US">${esc(message)}</faultstring></s:Fault>`
    );
  }
  private reply(name: string, inner: string, errors?: Array<[string, string]>): Response {
    const notes = (errors ?? [])
      .map(
        ([c, m]) =>
          `<Notification><Code>${esc(c)}</Code><Message>${esc(m)}</Message></Notification>`
      )
      .join('');
    return this.soap(
      200,
      `<${name} xmlns="${ARAMEX_NS}"><Transaction><Reference1/><Reference2/><Reference3/><Reference4/><Reference5/></Transaction><Notifications>${notes}</Notifications><HasErrors>${errors?.length ? 'true' : 'false'}</HasErrors>${inner}</${name}>`
    );
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname.replace('/ShippingAPI.V2', '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const h = (n: string) =>
      Object.entries(headers).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
    const action = h('SOAPAction')?.replace(/^"|"$/g, '');
    this.requests.push({ path, action });
    const early = await this.faults.enter();
    if (early) return early;
    const service = /^\/(\w+)\/Service_1_0\.svc$/.exec(path)?.[1] ?? '';
    const xml = String(init?.body ?? '');
    this.log.push({ path, service, action, contentType: h('Content-Type'), xml });
    if (this.faultNext) {
      const m = this.faultNext;
      this.faultNext = null;
      return this.fault(500, 'Server', m);
    }
    if (init?.method !== 'POST' || !h('Content-Type')?.startsWith('text/xml')) {
      return this.fault(415, 'Client', 'stub: not a SOAP 1.1 POST');
    }
    const bad = validateAramexRequest(service, xml);
    if (bad.length) {
      this.violations.push(...bad);
      return this.fault(500, 'Client', `stub: WSDL violation: ${bad.slice(0, 3).join(' | ')}`);
    }
    const doc = parseXml(xml)!;
    const wrapper = doc.getElementsByTagNameNS('*', 'Body')[0].children[0];
    const [svc, op] = OPERATION_OF[wrapper.localName];
    if (svc !== service || action !== `http://ws.aramex.net/ShippingAPI/v1/Service_1_0/${op}`) {
      this.violations.push(`SOAPAction ${String(action)} does not match ${service}/${op}`);
      return this.fault(500, 'Client', 'stub: SOAPAction mismatch');
    }
    if (this.errorNext) {
      const m = this.errorNext;
      this.errorNext = null;
      return this.reply(wrapper.localName.replace('Request', 'Response'), '', [['ERR99', m]]);
    }
    const ci = wrapper.getElementsByTagNameNS(ARAMEX_NS, 'ClientInfo')[0];
    const c = ARAMEX_STUB.credentials;
    if (
      this.rejectAuth ||
      txt(ci, 'UserName') !== c.username ||
      txt(ci, 'Password') !== c.password ||
      txt(ci, 'AccountPin') !== c.accountPin
    ) {
      return this.reply(wrapper.localName.replace('Request', 'Response'), '', [
        ['AUTH', 'Authentication failed: invalid credentials'],
      ]);
    }

    switch (op) {
      case 'CreateShipments': {
        const sh = wrapper.getElementsByTagNameNS(ARAMEX_NS, 'Shipment')[0];
        if (this.failNextShipment) {
          const m = this.failNextShipment;
          this.failNextShipment = null;
          return this.reply(
            'ShipmentCreationResponse',
            `<Shipments><ProcessedShipment><ID/><Reference1/><Reference2/><Reference3/><ForeignHAWB/><HasErrors>true</HasErrors><Notifications><Notification><Code>ERR52</Code><Message>${esc(m)}</Message></Notification></Notifications><ShipmentLabel><LabelURL/><LabelFileContents/></ShipmentLabel></ProcessedShipment></Shipments>`
          );
        }
        const cod = sh.getElementsByTagNameNS(ARAMEX_NS, 'CashOnDeliveryAmount')[0];
        const waybill = `ARX${String(this.parcels.size + 1).padStart(9, '0')}`;
        this.parcels.set(waybill, {
          waybill,
          reference: txt(sh, 'Reference1'),
          codValue: cod ? Number(txt(cod, 'Value')) : null,
          codCurrency: cod ? txt(cod, 'CurrencyCode') : null,
          codMinor: cod ? egpToPiastres(txt(cod, 'Value')) : 0,
          services: txt(sh, 'Services') || null,
          updates: [this.event('created')],
          pickedUp: false,
        });
        return this.reply(
          'ShipmentCreationResponse',
          `<Shipments><ProcessedShipment><ID>${waybill}</ID><Reference1>${esc(this.parcels.get(waybill)!.reference)}</Reference1><Reference2/><Reference3/><ForeignHAWB/><HasErrors>false</HasErrors><Notifications/><ShipmentLabel><LabelURL>http://aramex.stub/labels/${waybill}.pdf</LabelURL><LabelFileContents/></ShipmentLabel></ProcessedShipment></Shipments>`
        );
      }
      case 'PrintLabel': {
        const w = txt(wrapper, 'ShipmentNumber');
        if (!this.parcels.has(w)) {
          return this.reply('LabelPrintingResponse', '', [['ERR10', 'Unknown shipment number']]);
        }
        return this.reply(
          'LabelPrintingResponse',
          `<ShipmentNumber>${w}</ShipmentNumber><ShipmentLabel><LabelURL>http://aramex.stub/labels/${w}.pdf</LabelURL><LabelFileContents/></ShipmentLabel>`
        );
      }
      case 'CreatePickup':
        this.pickups += 1;
        return this.reply(
          'PickupCreationResponse',
          `<ProcessedPickup><ID>PU${this.pickups}</ID><GUID>00000000-0000-4000-8000-${String(this.pickups).padStart(12, '0')}</GUID><Reference1/><Reference2/><ProcessedShipments/></ProcessedPickup>`
        );
      case 'CancelPickup': {
        const guid = txt(wrapper, 'PickupGUID');
        const known = /^00000000-0000-4000-8000-(\d{12})$/.exec(guid);
        if (!known || Number(known[1]) > this.pickups || this.cancelledPickups.has(guid)) {
          return this.reply('PickupCancelationResponse', '<Message/>', [
            ['ERR52', 'Pickup cannot be cancelled'],
          ]);
        }
        this.cancelledPickups.add(guid);
        return this.reply('PickupCancelationResponse', '<Message>Pickup cancelled</Message>');
      }
      case 'TrackShipments': {
        const w = wrapper.getElementsByTagNameNS(ARAMEX_ARR_NS, 'string')[0]?.textContent ?? '';
        const p = this.parcels.get(w);
        if (!p) {
          return this.reply(
            'ShipmentTrackingResponse',
            `<TrackingResults xmlns:a="${ARAMEX_ARR_NS}"/><NonExistingWaybills xmlns:a="${ARAMEX_ARR_NS}"><a:string>${esc(w)}</a:string></NonExistingWaybills>`
          );
        }
        const rows = p.updates.map(u => ({ ...u }));
        if (this.historyOrder === 'desc') rows.reverse();
        const results = rows
          .map(
            u =>
              `<TrackingResult><WaybillNumber>${w}</WaybillNumber><UpdateCode>${u.UpdateCode}</UpdateCode><UpdateDescription>${esc(u.UpdateDescription)}</UpdateDescription><UpdateDateTime>${u.UpdateDateTime}</UpdateDateTime><UpdateLocation>Cairo</UpdateLocation><Comments/><ProblemCode/><GrossWeight>0.8</GrossWeight><ChargeableWeight>0.8</ChargeableWeight><WeightUnit>KG</WeightUnit><UpdateTimeZone/></TrackingResult>`
          )
          .join('');
        return this.reply(
          'ShipmentTrackingResponse',
          `<TrackingResults xmlns:a="${ARAMEX_ARR_NS}"><a:KeyValueOfstringArrayOfTrackingResultmFAkxlpY><a:Key>${w}</a:Key><a:Value>${results}</a:Value></a:KeyValueOfstringArrayOfTrackingResultmFAkxlpY></TrackingResults><NonExistingWaybills xmlns:a="${ARAMEX_ARR_NS}"/>`
        );
      }
      case 'CalculateRate':
        return this.reply(
          'RateCalculatorResponse',
          `<TotalAmount><CurrencyCode>${this.quoteCurrency}</CurrencyCode><Value>${this.quoteValue}</Value></TotalAmount>`
        );
      case 'FetchCountries':
        return this.reply(
          'CountriesFetchingResponse',
          '<Countries><Country><Code>EG</Code><Name>Egypt</Name><IsoCode>EG</IsoCode><StateRequired>false</StateRequired><PostCodeRequired>false</PostCodeRequired><PostCodeRegex xmlns:a="' +
            ARAMEX_ARR_NS +
            '"/><InternationalCallingNumber>20</InternationalCallingNumber></Country></Countries>'
        );
    }
    return this.fault(500, 'Client', `stub: no operation ${op}`);
  };

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString().slice(0, 19); // zone-less, like Aramex
  }

  private event(status: ShipmentStatus) {
    const [UpdateCode, UpdateDescription] = EVENT_FOR[status];
    return { UpdateCode, UpdateDescription, UpdateDateTime: this.tick() };
  }

  advance(waybill: string, status: ShipmentStatus) {
    const p = this.parcels.get(waybill);
    if (!p) throw new Error(`stub: unknown parcel ${waybill}`);
    if (status !== 'created') p.pickedUp = true;
    p.updates.push(this.event(status));
  }

  injectNextCall(fault: StubFault) {
    this.faults.injectNextCall(fault);
  }
}
