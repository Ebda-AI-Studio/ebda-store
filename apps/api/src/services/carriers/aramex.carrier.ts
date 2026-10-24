// ==========================================
// Aramex Carrier Implementation (SOAP 1.1, official WSDLs)
// ==========================================
//
// Built from the four public WSDLs on ws.aramex.net (Shipping, RateCalculator, Tracking,
// Location; one namespace, WCF BasicHttpBinding). Aramex enforces xs:sequence ORDER, so every
// request is assembled by a small builder that emits children in the schema's order, and every
// schema-required element is present even when empty. Re-verified 2026-10-24 against the official
// "Shipping Services API Manual" (aramex.com/docs/default-source/resourses/resourcesdata/
// shipping-services-api-manual.pdf, readable in a browser, 403 to plain HTTP clients): Source 24,
// units KG / CM, PaymentType P, service code CODS, ReportID 9201 + URL, EGP currency code, test host
// and Pickup.Status are now DOCUMENTED. Still `UNVERIFIED:` (the manual is silent): domestic
// product types, the tracking UpdateCode table, EGP COD enablement, Reference1 uniqueness.

import logger from '../../lib/logger';
import {
  carrierRequestText,
  egpToPiastres,
  piastresToEgp,
  resolveCarrierBaseUrl,
  type CarrierHttpOptions,
} from '../../lib/carrier-http';
import { IdempotencyCache, credentialScope } from '../payment-providers/gateway-http';
import {
  CarrierCallContext,
  CarrierCancelResult,
  CarrierCapabilities,
  CarrierError,
  CarrierLabel,
  CarrierQuote,
  CarrierQuoteRequest,
  CarrierShipmentRequest,
  CarrierShipmentResponse,
  CarrierTestResult,
  CarrierTrackingResponse,
  CarrierWebhookResult,
  ShipmentAddress,
  ShipmentStatus,
  ShippingCarrierProvider,
  TrackingHistoryEntry,
  type CarrierPickupRequest,
  type CarrierPickupResult,
} from './types';
import { cairoWallClock } from './pickup-time';

export const ARAMEX_BASE_URLS = {
  live: 'https://ws.aramex.net/ShippingAPI.V2',
  // Manual Appendix G (testing URLs): ws.dev.aramex.net/shippingapi.v2/<service>/service_1_0.svc.
  // UNVERIFIED: its WSDL could not be fetched from our network (no DNS answer 2026-10-24), so
  // whether it is IP-allow-listed is unknown. The manual lists test credentials for it.
  sandbox: 'https://ws.dev.aramex.net/ShippingAPI.V2',
};

const NS = 'http://ws.aramex.net/ShippingAPI/v1/';
const ARR_NS = 'http://schemas.microsoft.com/2003/10/Serialization/Arrays';
const ACTION_BASE = 'http://ws.aramex.net/ShippingAPI/v1/Service_1_0/';

type Service = 'Shipping' | 'RateCalculator' | 'Tracking' | 'Location';

export interface AramexCredentials {
  accountNumber: string;
  accountPin: string;
  accountEntity: string;
  accountCountryCode: string;
  username: string;
  password: string;
}

// ------------------------------------------------------------------ status mapping

// UNVERIFIED: this UpdateCode table is from memory, NOT from Aramex's manual (no WSDL carries
// one: UpdateCode is a free string). It is only a fallback behind the description heuristic.
const ARAMEX_STATUS_MAP: Record<string, ShipmentStatus> = {
  SH005: 'created',
  SH006: 'created',
  SH010: 'picked_up',
  SH011: 'picked_up',
  SH012: 'picked_up',
  SH020: 'in_transit',
  SH021: 'in_transit',
  SH022: 'in_transit',
  SH023: 'in_transit',
  SH024: 'in_transit',
  SH025: 'in_transit',
  SH030: 'in_transit',
  SH040: 'out_for_delivery',
  SH041: 'out_for_delivery',
  SH050: 'delivered',
  SH051: 'delivered',
  SH060: 'failed',
  SH061: 'failed',
  SH062: 'failed',
  SH063: 'failed',
  SH064: 'failed',
  SH070: 'returned',
  SH071: 'returned',
  SH072: 'returned',
  SH080: 'cancelled',
  SH081: 'cancelled',
};

// UNVERIFIED heuristic on UpdateDescription (free text). Order matters: "returned" and "failed"
// are tested before "delivered" because "delivery attempt failed" / "returned, not delivered"
// contain the word "deliver"; "out for delivery" before "delivered" for the same reason.
const DESCRIPTION_RULES: Array<[RegExp, ShipmentStatus]> = [
  [/return/i, 'returned'],
  [/fail|unsuccess|attempt|undeliver|not delivered|refus|rejected/i, 'failed'],
  [/out for delivery/i, 'out_for_delivery'],
  [/deliver/i, 'delivered'],
  [/cancel/i, 'cancelled'],
  [/pick/i, 'picked_up'],
];

/**
 * UNVERIFIED mapping of one Aramex tracking event. Description pattern first, then the
 * from-memory code table; an event with text that matches nothing is `in_transit`; an event with
 * neither a usable description nor a known code keeps `previous` (the last known status) rather
 * than inventing movement.
 */
export function mapAramexStatus(
  updateCode: string,
  updateDescription?: string,
  previous?: ShipmentStatus
): ShipmentStatus {
  const description = (updateDescription ?? '').trim();
  if (description) {
    for (const [re, status] of DESCRIPTION_RULES) if (re.test(description)) return status;
  }
  const byCode = ARAMEX_STATUS_MAP[(updateCode ?? '').trim().toUpperCase()];
  if (byCode) return byCode;
  if (description) return 'in_transit';
  return previous ?? 'in_transit';
}

// ------------------------------------------------------------------ XML building

/** Escape a value for element text and drop characters XML 1.0 cannot carry. */
export function xmlEscape(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** An element with escaped text; absent -> omitted, or an empty element when schema-required. */
function t(name: string, value: unknown, required = false): string {
  if (value === undefined || value === null || value === '') return required ? `<${name}/>` : '';
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

/** An element whose body is already-built XML. */
function el(name: string, inner: string): string {
  return `<${name}>${inner}</${name}>`;
}

function num(name: string, value: number, required = false): string {
  if (!Number.isFinite(value)) {
    throw new CarrierError('CARRIER_REJECTED', `${name} must be a finite number`);
  }
  return t(name, String(value), required);
}

const money = (name: string, currency: string, value: number) =>
  el(name, t('CurrencyCode', currency, true) + num('Value', value, true));
const weight = (name: string, kg: number) =>
  el(name, t('Unit', 'KG', true) + num('Value', kg, true)); // manual Table 28: KG | LB

function clientInfo(c: AramexCredentials): string {
  return el(
    'ClientInfo',
    t('UserName', c.username, true) +
      t('Password', c.password, true) +
      t('Version', 'v1.0', true) + // manual: "based on the WSDL version", max 4 chars (v1.0 is the WSDL's)
      t('AccountNumber', c.accountNumber, true) +
      t('AccountPin', c.accountPin, true) +
      t('AccountEntity', c.accountEntity, true) +
      t('AccountCountryCode', c.accountCountryCode, true) +
      t('Source', 24) // manual Table 16: Source, Default = 24
  );
}

/** Transaction has Reference1..5 all schema-required. */
function transaction(ref1: string): string {
  return el(
    'Transaction',
    t('Reference1', ref1, true) +
      t('Reference2', '', true) +
      t('Reference3', '', true) +
      t('Reference4', '', true) +
      t('Reference5', '', true)
  );
}

const labelInfo = () =>
  // Manual Table 26: ReportID 9201; ReportType "URL by default" (or RPT = streamed file).
  el('LabelInfo', num('ReportID', 9201, true) + t('ReportType', 'URL', true));

function addressBody(a: ShipmentAddress, line3 = '', allRequired = false): string {
  return (
    t('Line1', a.line1, allRequired) +
    t('Line2', a.line2, allRequired) +
    t('Line3', line3, allRequired) +
    t('City', a.city, allRequired) +
    t('StateOrProvinceCode', a.state) +
    t('PostCode', a.postalCode, allRequired) +
    t('CountryCode', a.country, allRequired)
  );
}

function contactBody(a: ShipmentAddress): string {
  return (
    t('PersonName', a.name, true) +
    t('CompanyName', a.name) +
    t('PhoneNumber1', a.phone, true) +
    t('PhoneNumber2', '', true) + // schema-required, we hold one number
    t('CellPhone', a.phone) +
    t('EmailAddress', a.email) +
    t('Type', '', true) // UNVERIFIED: allowed values
  );
}

// ------------------------------------------------------------------ XML parsing (tolerant)

export interface XNode {
  name: string; // local name, namespace prefix dropped
  text: string;
  children: XNode[];
  nil: boolean;
}

const MAX_XML_CHARS = 8_000_000;

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
}

/**
 * A minimal namespace-agnostic XML reader: enough for SOAP answers, no DTD/entity expansion
 * (only the five predefined entities and numeric references). Returns a synthetic root.
 */
export function parseXml(src: string): XNode {
  if (src.length > MAX_XML_CHARS) {
    throw new CarrierError('CARRIER_UNAVAILABLE', 'Aramex answered with an oversized body');
  }
  const root: XNode = { name: '#root', text: '', children: [], nil: false };
  const stack: XNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const cur = stack[stack.length - 1];
    if (lt === -1) {
      cur.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) cur.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      cur.text += src.slice(lt + 9, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
    } else if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt + 2);
      const name = localName(src.slice(lt + 2, end === -1 ? src.length : end).trim());
      i = end === -1 ? src.length : end + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
    } else {
      // open tag: find the closing '>' outside quoted attribute values
      let j = lt + 1;
      let quote = '';
      while (j < src.length) {
        const ch = src[j];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        j++;
      }
      let inner = src.slice(lt + 1, j);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner);
      i = j + 1;
      if (!m) continue;
      const node: XNode = {
        name: localName(m[1]),
        text: '',
        children: [],
        nil: /\bnil\s*=\s*["']true["']/i.test(m[2]),
      };
      cur.children.push(node);
      if (!selfClose) {
        if (stack.length > 200) {
          throw new CarrierError('CARRIER_UNAVAILABLE', 'Aramex answered with a malformed body');
        }
        stack.push(node);
      }
    }
  }
  return root;
}

const localName = (n: string) => n.slice(n.lastIndexOf(':') + 1);

const kids = (n: XNode | undefined, name: string): XNode[] =>
  n ? n.children.filter(c => c.name === name) : [];
const kid = (n: XNode | undefined, name: string): XNode | undefined => kids(n, name)[0];
const val = (n: XNode | undefined, name?: string): string => {
  const x = name ? kid(n, name) : n;
  return x && !x.nil ? x.text.trim() : '';
};
function descend(n: XNode, name: string): XNode | undefined {
  for (const c of n.children) {
    if (c.name === name) return c;
    const d = descend(c, name);
    if (d) return d;
  }
  return undefined;
}

// ------------------------------------------------------------------ errors

interface Notification {
  code: string;
  message: string;
}

const notificationsOf = (n: XNode | undefined): Notification[] =>
  kids(kid(n, 'Notifications'), 'Notification').map(x => ({
    code: val(x, 'Code'),
    message: val(x, 'Message'),
  }));

// Manual Appendix F: ERR01 "Invalid username or password", ERR02 "Invalid account information",
// ERR03 "Account is blocked". Classified by CODE first; wording is only the fallback for SOAP faults
// and unlisted texts (no WSDL carries auth codes).
const AUTH_CODES = new Set(['ERR01', 'ERR02', 'ERR03']);
const AUTH_LOOKING =
  /authenticat|authoriz|unauthori|credential|password|user ?name|login|invalid (user|account)|\bpin\b|account (number|pin|entity)/i;

function scrub(text: string, c?: AramexCredentials): string {
  let out = text;
  for (const secret of [c?.password, c?.accountPin]) {
    if (secret && secret.length >= 3) out = out.split(secret).join('***');
  }
  return out.length > 300 ? `${out.slice(0, 300)}...` : out;
}

function describe(ns: Notification[], c?: AramexCredentials): string {
  if (ns.length === 0) return 'Aramex reported an error without details';
  return scrub(
    ns
      .slice(0, 5)
      .map(n => `[${n.code}] ${n.message}`)
      .join('; '),
    c
  );
}

const looksLikeAuth = (ns: Notification[]) =>
  ns.some(n => AUTH_CODES.has(n.code.trim().toUpperCase()) || AUTH_LOOKING.test(n.message));

function refusal(op: string, ns: Notification[], c?: AramexCredentials): CarrierError {
  if (looksLikeAuth(ns)) {
    return new CarrierError('CARRIER_MISCONFIGURED', 'Aramex refused the credentials');
  }
  return new CarrierError('CARRIER_REJECTED', `${op}: Aramex error: ${describe(ns, c)}`);
}

// ------------------------------------------------------------------ the adapter

export interface AramexPickupInput {
  address: ShipmentAddress;
  pickupDate: Date;
  readyTime: Date;
  lastPickupTime: Date;
  closingTime: Date;
  reference?: string;
  comments?: string;
  vehicle?: string; // UNVERIFIED: default 'Car'
  shipments: number;
  pieces?: number;
  weightKg?: number;
}

export class AramexCarrier implements ShippingCarrierProvider {
  readonly name = 'Aramex';
  readonly code = 'aramex';
  readonly capabilities: CarrierCapabilities = {
    quote: true,
    label: true,
    // None of the four WSDLs has a push/subscription operation: tracking is POLLED.
    webhooks: false,
    polling: true,
    // UNVERIFIED: domestic COD in EGP. COD is refused until the merchant records Aramex's
    // written confirmation (settings.codEgpConfirmed). Prepaid shipments are unaffected.
    cod: 'unconfirmed',
    // Shipping/CreatePickup (PickupDate, ReadyTime, LastPickupTime, ClosingTime): a merchant window.
    pickup: 'request',
    pickupWindow: 'times',
    // Shipping/CancelPickup (PickupGUID).
    pickupCancel: true,
  };

  // Aramex documents no idempotency key and has no search-by-reference operation, so a lost
  // response after a successful CreateShipments CANNOT be detected here. UNVERIFIED: whether
  // Aramex rejects a repeated Reference1. This per-process cache (credential-scoped, keyed on the
  // merchant reference) only stops in-process repeats; the service keeps one shipment row per
  // order, and retrying after an ambiguous failure is the merchant's / ops' decision.
  private readonly created = new IdempotencyCache<CarrierShipmentResponse>();

  constructor(private readonly http: CarrierHttpOptions = {}) {}

  /** One SOAP call; returns the response element. Throws CarrierError on every failure shape. */
  private async call(
    service: Service,
    operation: string,
    requestName: string,
    responseName: string,
    body: string,
    ctx: CarrierCallContext | undefined,
    creds: AramexCredentials
  ): Promise<XNode> {
    const sandbox = ctx?.settings?.sandbox === true || ctx?.settings?.sandbox === 'true';
    const base = resolveCarrierBaseUrl(
      'ARAMEX_BASE_URL',
      ARAMEX_BASE_URLS,
      sandbox,
      this.http.baseUrl
    );
    const op = `aramex.${operation}`;
    const envelope =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      `<${requestName} xmlns="${NS}" xmlns:arr="${ARR_NS}">${body}</${requestName}>` +
      '</s:Body></s:Envelope>';
    const res = await carrierRequestText(
      op,
      base,
      `/${service}/Service_1_0.svc`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          // SOAP 1.1 wants the action quoted
          SOAPAction: `"${ACTION_BASE}${operation}"`,
        },
        body: envelope,
      },
      { ...this.http, acceptStatus: [500] }
    );

    let root: XNode;
    try {
      root = parseXml(res.text);
    } catch (e) {
      if (e instanceof CarrierError) throw e;
      throw new CarrierError('CARRIER_UNAVAILABLE', `${op}: unreadable answer`);
    }

    const fault = descend(root, 'Fault');
    if (fault || res.status === 500) {
      const faultText = scrub(
        val(fault, 'faultstring') || val(descend(fault ?? root, 'Text')),
        creds
      );
      if (AUTH_LOOKING.test(faultText)) {
        throw new CarrierError('CARRIER_MISCONFIGURED', 'Aramex refused the credentials');
      }
      const clientFault = /client|sender/i.test(val(fault, 'faultcode'));
      logger.warn({ carrier: 'aramex', op, status: res.status }, 'Aramex SOAP fault');
      throw new CarrierError(
        clientFault && res.status < 500 ? 'CARRIER_REJECTED' : 'CARRIER_UNAVAILABLE',
        `${op}: Aramex fault${faultText ? `: ${faultText}` : ` (HTTP ${res.status})`}`
      );
    }

    const response = descend(root, responseName);
    if (!response) {
      throw new CarrierError(
        'CARRIER_UNAVAILABLE',
        `${op}: unexpected answer (no ${responseName})`
      );
    }
    if (val(response, 'HasErrors').toLowerCase() === 'true') {
      throw refusal(op, notificationsOf(response), creds);
    }
    return response;
  }

  private productSettings(ctx: CarrierCallContext | undefined, domestic: boolean) {
    const productType = ctx?.settings?.productType;
    if (typeof productType !== 'string' || !productType.trim()) {
      throw new CarrierError(
        'CARRIER_MISCONFIGURED',
        'Set the Aramex product type in the carrier settings (ask Aramex which domestic product your account uses)'
      );
    }
    const group = ctx?.settings?.productGroup;
    return {
      // Manual (ShipmentDetails): Product Group is EXP or DOM. The manual's Appendix A lists only EXP product
      // types (PDX PPX PLX DDX DPX GDX GPX EPX): the DOM types stay UNVERIFIED, hence the setting.
      productGroup:
        typeof group === 'string' && group.trim() ? group.trim() : domestic ? 'DOM' : 'EXP',
      productType: productType.trim(),
    };
  }

  private checkCod(codAmount: number | undefined, ctx: CarrierCallContext | undefined): number {
    const cod = codAmount ?? 0;
    if (!Number.isSafeInteger(cod) || cod < 0) {
      throw new CarrierError('CARRIER_REJECTED', 'codAmount must be integer piastres');
    }
    if (cod > 0 && ctx?.settings?.codEgpConfirmed !== true) {
      throw new CarrierError(
        'COD_NOT_SUPPORTED',
        'Aramex cash on delivery in EGP is not confirmed for this account. Ask Aramex to confirm in writing, then tick "COD in EGP confirmed" in the Aramex settings; until then ship COD orders with another carrier.'
      );
    }
    return cod;
  }

  /** ShipmentDetails BODY in schema order (the same type is used by CreateShipments and CalculateRate). */
  private details(o: {
    group: string;
    type: string;
    kg: number;
    goods: string;
    origin: string;
    dims?: { length: number; width: number; height: number };
    cod: number;
  }): string {
    const d = o.dims ?? { length: 0, width: 0, height: 0 }; // UNVERIFIED: zeros accepted
    return (
      el(
        'Dimensions',
        num('Length', d.length, true) +
          num('Width', d.width, true) +
          num('Height', d.height, true) +
          t('Unit', 'CM', true) // manual Table 27: CM | M
      ) +
      weight('ActualWeight', o.kg) +
      weight('ChargeableWeight', o.kg) +
      t('DescriptionOfGoods', o.goods, true) +
      t('GoodsOriginCountry', o.origin, true) +
      num('NumberOfPieces', 1, true) + // one parcel per shipment
      t('ProductGroup', o.group, true) +
      t('ProductType', o.type, true) +
      t('PaymentType', 'P', true) + // manual Appendix B: P = prepaid (shipper pays transport)
      t('PaymentOptions', '', true) +
      (o.cod > 0 ? money('CashOnDeliveryAmount', 'EGP', piastresToEgp(o.cod)) : '') +
      (o.cod > 0 ? t('Services', 'CODS') : '') // manual Appendix C: CODS = Cash on Delivery
    );
  }

  async createShipment(
    credentials: AramexCredentials,
    data: CarrierShipmentRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierShipmentResponse> {
    const cod = this.checkCod(data.codAmount, ctx);
    const domestic = data.pickupAddress.country === data.deliveryAddress.country;
    const product = this.productSettings(ctx, domestic);
    const reference = data.merchantReference ?? data.orderId;
    return this.created.once(
      credentialScope([credentials.accountNumber, credentials.accountEntity]),
      reference,
      () => this.book(credentials, data, ctx, cod, product, reference)
    );
  }

  private async book(
    credentials: AramexCredentials,
    data: CarrierShipmentRequest,
    ctx: CarrierCallContext | undefined,
    cod: number,
    product: { productGroup: string; productType: string },
    reference: string
  ): Promise<CarrierShipmentResponse> {
    const d = data.deliveryAddress;
    const line3 = [d.area, d.block, d.street].filter(Boolean).join(', ');
    const shipment = el(
      'Shipment',
      t('Reference1', reference) +
        el(
          'Shipper',
          t('Reference1', data.orderNumber) +
            t('AccountNumber', credentials.accountNumber) +
            el('PartyAddress', addressBody(data.pickupAddress)) +
            el('Contact', contactBody(data.pickupAddress))
        ) +
        el(
          'Consignee',
          t('Reference1', data.orderNumber) +
            el('PartyAddress', addressBody(d, line3)) +
            el('Contact', contactBody(d))
        ) +
        t('ShippingDateTime', new Date().toISOString(), true) +
        t('DueDate', new Date(Date.now() + 7 * 86_400_000).toISOString()) +
        t('Comments', data.notes) +
        el(
          'Details',
          this.details({
            group: product.productGroup,
            type: product.productType,
            kg: data.weight ?? 0.5,
            goods: data.items.map(i => i.name).join(', ') || 'Goods',
            origin: data.pickupAddress.country,
            dims: data.dimensions,
            cod,
          })
        )
    );
    const response = await this.call(
      'Shipping',
      'CreateShipments',
      'ShipmentCreationRequest',
      'ShipmentCreationResponse',
      clientInfo(credentials) +
        transaction(data.orderNumber) +
        el('Shipments', shipment) +
        labelInfo(),
      ctx,
      credentials
    );
    const processed = kid(kid(response, 'Shipments'), 'ProcessedShipment');
    if (!processed) {
      throw new CarrierError(
        'CARRIER_UNAVAILABLE',
        'aramex.CreateShipments: no processed shipment in the answer'
      );
    }
    if (val(processed, 'HasErrors').toLowerCase() === 'true') {
      throw refusal('aramex.CreateShipments', notificationsOf(processed), credentials);
    }
    const id = val(processed, 'ID');
    if (!id) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'aramex.CreateShipments: no waybill id');
    }
    const url = val(kid(processed, 'ShipmentLabel'), 'LabelURL');
    return {
      carrierShipmentId: id,
      trackingNumber: id,
      // UNVERIFIED: public tracking page
      trackingUrl: `https://www.aramex.com/express/track.aspx?mode=1&ShipmentNumber=${encodeURIComponent(id)}`,
      labelUrl: /^https?:\/\//i.test(url) ? url : undefined,
    };
  }

  async getLabel(
    credentials: AramexCredentials,
    shipment: { carrierShipmentId: string; trackingNumber: string },
    ctx?: CarrierCallContext
  ): Promise<CarrierLabel> {
    const group = ctx?.settings?.productGroup;
    const response = await this.call(
      'Shipping',
      'PrintLabel',
      'LabelPrintingRequest',
      'LabelPrintingResponse',
      clientInfo(credentials) +
        transaction(`label-${shipment.trackingNumber}`) +
        t('ShipmentNumber', shipment.trackingNumber, true) +
        t('ProductGroup', typeof group === 'string' && group ? group : 'DOM') +
        t('OriginEntity', credentials.accountEntity) + // UNVERIFIED: the shipment's origin entity
        labelInfo(),
      ctx,
      credentials
    );
    const lbl = kid(response, 'ShipmentLabel');
    const url = val(lbl, 'LabelURL');
    if (/^https?:\/\//i.test(url)) return { url };
    const b64 = val(lbl, 'LabelFileContents').replace(/\s+/g, '');
    if (b64 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { pdfBase64: b64 };
    throw new CarrierError('CARRIER_UNAVAILABLE', 'aramex.PrintLabel: no label in the answer');
  }

  async quote(
    credentials: AramexCredentials,
    data: CarrierQuoteRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierQuote> {
    const cod = this.checkCod(data.codAmount, ctx);
    const domestic = data.pickupAddress.country === data.deliveryAddress.country;
    const product = this.productSettings(ctx, domestic);
    const details = this.details({
      group: product.productGroup,
      type: product.productType,
      kg: data.weight ?? 0.5,
      goods: 'Goods',
      origin: data.pickupAddress.country,
      cod,
    });
    const response = await this.call(
      'RateCalculator',
      'CalculateRate',
      'RateCalculatorRequest',
      'RateCalculatorResponse',
      clientInfo(credentials) +
        transaction('quote') +
        el('OriginAddress', addressBody(data.pickupAddress, '', true)) +
        el('DestinationAddress', addressBody(data.deliveryAddress, '', true)) +
        el('ShipmentDetails', details) +
        t('PreferredCurrencyCode', 'EGP'),
      ctx,
      credentials
    );
    const total = kid(response, 'TotalAmount');
    const currency = val(total, 'CurrencyCode');
    if (!total || currency !== 'EGP') {
      // never convert silently: a USD quote is not a piastre amount
      throw new CarrierError(
        'CARRIER_REJECTED',
        `Aramex quoted in ${currency || 'an unknown currency'}, not EGP`
      );
    }
    return { amountPiastres: egpToPiastres(val(total, 'Value')), source: 'api' };
  }

  /** Not part of the shared interface: book a courier pickup (Shipping/CreatePickup). */
  async createPickup(
    credentials: AramexCredentials,
    input: AramexPickupInput,
    ctx?: CarrierCallContext
  ): Promise<{ pickupId: string; pickupGuid: string }> {
    const product = this.productSettings(ctx, true);
    const kg = input.weightKg ?? 0.5;
    const pickup = el(
      'Pickup',
      el('PickupAddress', addressBody(input.address)) +
        el('PickupContact', contactBody(input.address)) +
        t('PickupLocation', 'Reception', true) + // UNVERIFIED: free text
        t('PickupDate', input.pickupDate.toISOString(), true) +
        t('ReadyTime', input.readyTime.toISOString(), true) +
        t('LastPickupTime', input.lastPickupTime.toISOString(), true) +
        t('ClosingTime', input.closingTime.toISOString(), true) +
        t('Comments', input.comments, true) +
        t('Reference1', input.reference) +
        t('Vehicle', input.vehicle ?? 'Car', true) + // UNVERIFIED: vehicle vocabulary
        el(
          'PickupItems',
          el(
            'PickupItemDetail',
            t('ProductGroup', product.productGroup, true) +
              t('ProductType', product.productType, true) +
              num('NumberOfShipments', input.shipments, true) +
              t('PackageType', 'Box', true) + // UNVERIFIED
              t('Payment', 'P', true) + // UNVERIFIED
              weight('ShipmentWeight', kg) +
              // Manual Table 30: Value must be > 0 (ERR23), unit written "Cm3"; we do not know the volume, so
              // the smallest positive placeholder is sent (UNVERIFIED how Aramex uses it for a pickup).
              el('ShipmentVolume', t('Unit', 'Cm3', true) + num('Value', 1, true)) +
              num('NumberOfPieces', input.pieces ?? input.shipments, true) +
              money('CashAmount', 'EGP', 0) +
              money('ExtraCharges', 'EGP', 0) +
              el(
                'ShipmentDimensions',
                num('Length', 0, true) +
                  num('Width', 0, true) +
                  num('Height', 0, true) +
                  t('Unit', 'CM', true)
              ) +
              t('Comments', '', true)
          )
        ) +
        // Manual Table 31: Status is mandatory, "Ready" or "Pending" (REQ27 "Status is empty").
        // Schema order: Status follows PickupItems.
        t('Status', 'Ready', true)
    );
    const response = await this.call(
      'Shipping',
      'CreatePickup',
      'PickupCreationRequest',
      'PickupCreationResponse',
      clientInfo(credentials) + transaction(input.reference ?? 'pickup') + pickup + labelInfo(),
      ctx,
      credentials
    );
    const p = kid(response, 'ProcessedPickup');
    const pickupId = val(p, 'ID');
    const pickupGuid = val(p, 'GUID');
    if (!pickupId && !pickupGuid) {
      throw new CarrierError('CARRIER_UNAVAILABLE', 'aramex.CreatePickup: no pickup in the answer');
    }
    return { pickupId, pickupGuid };
  }

  /** Shared pickup action (PROVIDERS-18): the merchant's Cairo window becomes the four times. */
  async schedulePickup(
    credentials: AramexCredentials,
    req: CarrierPickupRequest,
    ctx?: CarrierCallContext
  ): Promise<CarrierPickupResult> {
    if (!req.window) {
      throw new CarrierError('CARRIER_REJECTED', 'Aramex needs a pickup window (from / to)');
    }
    const from = cairoWallClock(req.date, req.window.from);
    const to = cairoWallClock(req.date, req.window.to);
    const out = await this.createPickup(
      credentials,
      {
        address: req.address,
        pickupDate: from,
        readyTime: from,
        lastPickupTime: to,
        closingTime: to,
        reference: req.reference,
        shipments: Math.max(1, req.trackingNumbers.length),
        weightKg: req.weightKg,
        comments: req.trackingNumbers.length ? `AWB ${req.trackingNumbers.join(', ')}` : undefined,
      },
      ctx
    );
    // CancelPickup takes the GUID; the ID is what Aramex's people quote.
    return { carrierPickupId: out.pickupGuid || out.pickupId, carrierReference: out.pickupId };
  }

  /** Shipping/CancelPickup by GUID; `HasErrors` (thrown by `call`) is a refusal. */
  async cancelPickup(
    credentials: AramexCredentials,
    pickup: { carrierPickupId: string },
    ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult> {
    try {
      await this.call(
        'Shipping',
        'CancelPickup',
        'PickupCancelationRequest',
        'PickupCancelationResponse',
        clientInfo(credentials) +
          transaction('cancel-pickup') +
          t('PickupGUID', pickup.carrierPickupId, true) +
          t('Comments', 'Cancelled by the merchant', true),
        ctx,
        credentials
      );
    } catch (err) {
      if (err instanceof CarrierError && err.code === 'CARRIER_REJECTED') {
        return { status: 'not_cancellable', message: err.message };
      }
      throw err;
    }
    return { status: 'cancelled' };
  }

  async trackShipment(
    credentials: AramexCredentials,
    trackingNumber: string,
    ctx?: CarrierCallContext
  ): Promise<CarrierTrackingResponse> {
    const response = await this.call(
      'Tracking',
      'TrackShipments',
      'ShipmentTrackingRequest',
      'ShipmentTrackingResponse',
      clientInfo(credentials) +
        transaction(`track-${trackingNumber}`) +
        el('Shipments', `<arr:string>${xmlEscape(trackingNumber)}</arr:string>`) +
        '<GetLastTrackingUpdateOnly>false</GetLastTrackingUpdateOnly>',
      ctx,
      credentials
    );
    const missing = kids(kid(response, 'NonExistingWaybills'), 'string').map(s => val(s));
    if (missing.includes(trackingNumber)) {
      throw new CarrierError(
        'CARRIER_REJECTED',
        'Aramex does not know this waybill (unknown waybill)'
      );
    }
    // the dictionary type name carries a generated suffix in the WSDL: match by prefix
    const pool = (kid(response, 'TrackingResults')?.children ?? []).filter(c =>
      c.name.startsWith('KeyValueOfstringArrayOfTrackingResult')
    );
    const entry = pool.find(e => val(e, 'Key') === trackingNumber) ?? pool[0];
    const results = kids(kid(entry, 'Value'), 'TrackingResult');

    const raw = results
      .map(r => ({
        code: val(r, 'UpdateCode'),
        description: val(r, 'UpdateDescription'),
        timestamp: parseAramexDate(val(r, 'UpdateDateTime')),
        location: val(r, 'UpdateLocation') || undefined,
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    // oldest first; an event Aramex gives us nothing usable for keeps the last known status
    let last: ShipmentStatus = 'created';
    const history: TrackingHistoryEntry[] = raw.map(e => {
      last = mapAramexStatus(e.code, e.description, last);
      return {
        status: last,
        timestamp: e.timestamp,
        location: e.location,
        description: e.description || undefined,
      };
    });
    return {
      status: history.length ? history[history.length - 1].status : 'created',
      statusHistory: history,
      estimatedDelivery: undefined,
    };
  }

  async cancelShipment(
    _credentials: AramexCredentials,
    _carrierShipmentId: string,
    _ctx?: CarrierCallContext
  ): Promise<CarrierCancelResult> {
    // None of the four WSDLs has a cancel-shipment operation (only CancelPickup by pickup GUID,
    // and HoldShipments). No network call: never report a cancel Aramex did not perform.
    return {
      status: 'not_cancellable',
      message:
        'Aramex has no cancel API for shipments: ask Aramex support to cancel it (or cancel in your Aramex portal), then use force-cancel here',
    };
  }

  processWebhook(_body: unknown, _headers: Record<string, string>): CarrierWebhookResult | null {
    return null; // no push/subscription operation exists in the Aramex WSDLs
  }

  async testConnection(
    credentials: AramexCredentials,
    ctx?: CarrierCallContext
  ): Promise<CarrierTestResult> {
    try {
      // Location/FetchCountries: a read-only lookup. OBSERVED 2026-10-07 against the live host with a
      // fake account: it DOES authenticate ClientInfo (HTTP 200, HasErrors=true, ERR75 "Failed to
      // login"), so garbage credentials cannot pass it (tests/unit/aramex-observed-auth-failure.test.ts).
      const response = await this.call(
        'Location',
        'FetchCountries',
        'CountriesFetchingRequest',
        'CountriesFetchingResponse',
        clientInfo(credentials) + transaction('connection-test'),
        ctx,
        credentials
      );
      void response;
      return { success: true };
    } catch (err) {
      if (err instanceof CarrierError) {
        if (err.code === 'CARRIER_MISCONFIGURED') {
          return {
            success: false,
            code: 'bad_credentials',
            error: 'Aramex refused the credentials',
          };
        }
        if (err.code === 'CARRIER_UNAVAILABLE') {
          return { success: false, code: 'unreachable', error: scrub(err.message, credentials) };
        }
        return { success: false, code: 'unknown', error: scrub(err.message, credentials) };
      }
      logger.error({ carrier: 'aramex' }, 'Aramex testConnection error');
      return { success: false, code: 'unknown', error: 'Aramex test failed' };
    }
  }
}

/**
 * UNVERIFIED: Aramex answers xs:dateTime, often without a zone. A zone-less value is read as UTC
 * (deterministic, independent of the server's TZ); it may be Cairo local time, i.e. 2-3 h off.
 */
function parseAramexDate(s: string): Date {
  if (!s) return new Date();
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export const aramexCarrier = new AramexCarrier();

/**
 * Aramex requires an email for BOTH shipper and customer when a shipment is created (manual:
 * REQ24 "Email Address is empty" otherwise). Shipper: the merchant's pickup email, else the
 * store owner's account email. Customer: the order's email (customer account, else the one typed
 * at checkout). If either is still missing the booking is refused here with a merchant-facing
 * Arabic + English message, instead of sending an empty element Aramex rejects.
 */
export const ARAMEX_EMAIL_REQUIRED_MESSAGE =
  'أراميكس تشترط بريدًا إلكترونيًا للمرسل والعميل: أضف بريد الاستلام في إعدادات أراميكس، أو تأكد أن الطلب يحتوي على بريد العميل. / Aramex requires an email for both the sender and the customer: add a pickup email in the Aramex settings, or make sure the order has a customer email.';

export function withAramexEmails(
  pickup: ShipmentAddress,
  delivery: ShipmentAddress,
  fallbacks: { ownerEmail?: string | null; orderEmail?: string | null }
): { pickupAddress: ShipmentAddress; deliveryAddress: ShipmentAddress } {
  const clean = (v?: string | null) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const shipper = clean(pickup.email) ?? clean(fallbacks.ownerEmail);
  const customer = clean(delivery.email) ?? clean(fallbacks.orderEmail);
  if (!shipper || !customer) {
    throw new CarrierError('CARRIER_REJECTED', ARAMEX_EMAIL_REQUIRED_MESSAGE);
  }
  return {
    pickupAddress: { ...pickup, email: shipper },
    deliveryAddress: { ...delivery, email: customer },
  };
}
