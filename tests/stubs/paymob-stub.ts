/**
 * A local Paymob (Accept, Intention API) stub speaking the shapes in Paymob's official docs
 * (developers.paymob.com): cents == piastres integers, `Authorization: Token <secret key>` on
 * intention / refund / void, `POST /api/auth/tokens {api_key}` -> `{profile, token}`, order
 * inquiry as `POST /api/ecommerce/orders/transaction_inquiry {auth_token, order_id}` (no
 * Authorization header), the HMAC-SHA512 transaction callback and the unified checkout host.
 * Anything the docs do not state is `UNVERIFIED:` in the adapter, and 6c checks it against a
 * real sandbox.
 */
import crypto from 'node:crypto';
import { paymobHmac, PAYMOB_HMAC_HEADER } from '@api/services/payment-providers/paymob.provider';
import type { ContractControl, SignedWebhook } from '../contract/payment-provider.contract';
import { FaultGate, headerOf, json, readJson, type StubFault } from './stub-common';

export const PAYMOB_STUB = {
  /** Paymob SECRET key (creds.apiKey): `Authorization: Token <this>`. */
  secretKey: 'sk_test_paymob_stub',
  /** Paymob API KEY (creds.secretKey): only for POST /api/auth/tokens. */
  apiKey: 'paymob_stub_api_key',
  publicKey: 'pk_test_paymob_stub',
  hmacSecret: 'paymob-stub-hmac-secret',
  integrationIds: { card: 11, wallet: 22, valu: 33, kiosk: 44, applepay: 55 },
  baseUrl: 'https://paymob.stub.test',
  checkoutUrl: 'https://checkout.paymob.stub.test',
  authToken: 'stub_auth_token',
} as const;

interface Order {
  id: number;
  amount: number;
  merchantRef: string;
  methods: number[];
  txnId: number | null;
}
interface Txn {
  id: number;
  orderId: number;
  amount_cents: number;
  success: boolean;
  pending: boolean;
  is_voided: boolean;
  is_refunded: boolean;
  refunded_amount_cents: number;
  parent: number | null;
  integration_id: number;
  created_at: string;
  source_type: string;
}

export class PaymobStub {
  readonly orders = new Map<number, Order>();
  readonly txns = new Map<number, Txn>();
  readonly requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  readonly faults = new FaultGate();
  /** Simulates the daily settlement: voids are refused, refunds still work. */
  voidWindowOpen = true;
  private seq = 1000;

  get createdCount(): number {
    return this.orders.size;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = await readJson(init);
    // Recorded BEFORE the fault gate: a call the gateway "never answers" still reached it.
    this.requests.push({ path, body });
    const early = await this.faults.enter();
    if (early) return early;
    // Docs: auth token request and order inquiry carry their credential in the BODY.
    if (path === '/api/auth/tokens') return this.authTokens(body);
    if (path === '/api/ecommerce/orders/transaction_inquiry') return this.inquiry(body);
    if (headerOf(init, 'authorization') !== `Token ${PAYMOB_STUB.secretKey}`) {
      return json(401, { detail: 'Authentication credentials were not provided.' });
    }
    if (path === '/v1/intention/') return this.intention(body);
    if (path === '/api/acceptance/void_refund/refund') return this.refund(body);
    if (path === '/api/acceptance/void_refund/void') return this.void(body);
    return json(404, { detail: 'Not found.' });
  };

  private authTokens(b: Record<string, unknown>): Response {
    if (b.api_key !== PAYMOB_STUB.apiKey) {
      return json(401, { detail: 'Invalid api_key.' });
    }
    return json(200, { profile: { id: 106 }, token: PAYMOB_STUB.authToken });
  }

  private intention(b: Record<string, unknown>): Response {
    const amount = b.amount;
    if (!Number.isInteger(amount) || (amount as number) <= 0) {
      return json(400, { amount: ['A valid integer is required.'] });
    }
    if (b.currency !== 'EGP') return json(400, { currency: ['unsupported'] });
    const methods = b.payment_methods;
    const allowed = Object.values(PAYMOB_STUB.integrationIds) as number[];
    if (
      !Array.isArray(methods) ||
      methods.length === 0 ||
      !methods.every(m => allowed.includes(m as number))
    ) {
      return json(400, { payment_methods: ['unknown integration id'] });
    }
    const items = b.items as Array<{ amount: number; quantity: number }> | undefined;
    const total = (items ?? []).reduce((n, i) => n + i.amount * i.quantity, 0);
    if (!items || items.length === 0 || total !== amount) {
      return json(400, { detail: 'items amount does not equal the intention amount' });
    }
    const bd = b.billing_data as Record<string, string> | undefined;
    if (!bd || !bd.first_name || !bd.last_name || !bd.email || !bd.phone_number) {
      return json(400, { billing_data: ['required'] });
    }
    const order: Order = {
      id: ++this.seq,
      amount: amount as number,
      merchantRef: String(b.special_reference ?? ''),
      methods: methods as number[],
      txnId: null,
    };
    this.orders.set(order.id, order);
    return json(201, {
      payment_keys: [
        { integration: order.methods[0], key: 'stub_payment_key', order_id: order.id },
      ],
      id: `pi_test_stub${order.id}`,
      client_secret: `egy_csk_test_stub${order.id}`,
      intention_order_id: order.id,
      intention_detail: { amount: order.amount },
      special_reference: order.merchantRef,
      status: 'intended',
      object: 'paymentintention',
    });
  }

  private txnView(o: Order): Record<string, unknown> {
    const t = o.txnId ? this.txns.get(o.txnId) : undefined;
    if (!t) {
      return {
        id: null,
        success: false,
        pending: true,
        amount_cents: o.amount,
        is_voided: false,
        is_refunded: false,
        refunded_amount_cents: 0,
        currency: 'EGP',
        order: { id: o.id, amount_cents: o.amount, merchant_order_id: o.merchantRef },
      };
    }
    const { source_type, ...rest } = t;
    return {
      ...rest,
      currency: 'EGP',
      source_data: { type: source_type, pan: '2346', sub_type: 'MasterCard' },
      order: { id: o.id, amount_cents: o.amount, merchant_order_id: o.merchantRef },
    };
  }

  private inquiry(b: Record<string, unknown>): Response {
    if (b.auth_token !== PAYMOB_STUB.authToken) {
      return json(401, { detail: 'Invalid auth_token.' });
    }
    const o = this.orders.get(Number(b.order_id));
    return o ? json(200, this.txnView(o)) : json(404, { detail: 'order not found' });
  }

  private refund(b: Record<string, unknown>): Response {
    const t = this.txns.get(Number(b.transaction_id));
    if (!t || !t.success) return json(400, { detail: 'transaction not found or not captured' });
    const amount = b.amount_cents;
    if (!Number.isInteger(amount) || (amount as number) <= 0)
      return json(400, { amount_cents: ['invalid'] });
    if (t.is_voided || (amount as number) > t.amount_cents - t.refunded_amount_cents) {
      // Docs: the 400 message of an over-refund.
      return json(400, {
        message:
          'Requested Refund Amount is greater than the maximum refund amount permissible. Maximum Refund Amount is EGP 100.0',
      });
    }
    t.refunded_amount_cents += amount as number;
    t.is_refunded = t.refunded_amount_cents >= t.amount_cents;
    if (t.source_type === 'aggregator') {
      return json(400, { message: 'Kiosk payments cannot be refunded' });
    }
    const r: Txn = {
      id: ++this.seq,
      orderId: t.orderId,
      amount_cents: amount as number,
      success: true,
      pending: false,
      is_voided: false,
      is_refunded: true,
      refunded_amount_cents: 0,
      parent: t.id,
      integration_id: t.integration_id,
      created_at: new Date().toISOString(),
      source_type: t.source_type,
    };
    this.txns.set(r.id, r);
    return json(200, {
      ...r,
      is_refund: !r.is_voided,
      is_void: r.is_voided,
      parent_transaction: t.id,
    });
  }

  private void(b: Record<string, unknown>): Response {
    const t = this.txns.get(Number(b.transaction_id));
    if (!t || !t.success) return json(400, { detail: 'transaction not found or not captured' });
    if (t.source_type !== 'card') return json(400, { message: 'Only card payments can be voided' });
    if (!this.voidWindowOpen || t.refunded_amount_cents > 0 || t.is_voided) {
      return json(400, { detail: 'transaction can no longer be voided' });
    }
    t.is_voided = true;
    t.refunded_amount_cents = t.amount_cents;
    const r: Txn = {
      id: ++this.seq,
      orderId: t.orderId,
      amount_cents: t.amount_cents,
      success: true,
      pending: false,
      is_voided: true,
      is_refunded: false,
      refunded_amount_cents: 0,
      parent: t.id,
      integration_id: t.integration_id,
      created_at: new Date().toISOString(),
      source_type: t.source_type,
    };
    this.txns.set(r.id, r);
    return json(200, {
      ...r,
      is_refund: !r.is_voided,
      is_void: r.is_voided,
      parent_transaction: t.id,
    });
  }

  /** The customer pays: a successful transaction on the order. */
  capture(orderId: number, sourceType = 'card'): Txn {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`no stub order ${orderId}`);
    const t: Txn = {
      id: ++this.seq,
      orderId,
      amount_cents: o.amount,
      success: true,
      pending: false,
      is_voided: false,
      is_refunded: false,
      refunded_amount_cents: 0,
      parent: null,
      integration_id: o.methods[0],
      created_at: new Date().toISOString(),
      source_type: sourceType,
    };
    this.txns.set(t.id, t);
    o.txnId = t.id;
    return t;
  }

  /** The body Paymob POSTs to `notification_url` (+ the `hmac` it appends as a query parameter). */
  callbackFor(
    t: Pick<
      Txn,
      | 'id'
      | 'orderId'
      | 'amount_cents'
      | 'success'
      | 'pending'
      | 'is_voided'
      | 'is_refunded'
      | 'integration_id'
      | 'created_at'
    > & { parent?: number | null; source_type?: string },
    secret = PAYMOB_STUB.hmacSecret
  ): { body: Record<string, unknown>; hmac: string } {
    const obj = {
      id: t.id,
      pending: t.pending,
      amount_cents: t.amount_cents,
      success: t.success,
      is_auth: false,
      is_capture: false,
      is_standalone_payment: true,
      is_voided: t.is_voided,
      is_refunded: t.is_refunded,
      is_3d_secure: true,
      integration_id: t.integration_id,
      has_parent_transaction: Boolean(t.parent),
      parent_transaction: t.parent ?? null,
      error_occured: !t.success && !t.pending,
      owner: 1234,
      currency: 'EGP',
      created_at: t.created_at,
      order: { id: t.orderId, merchant_order_id: this.orders.get(t.orderId)?.merchantRef },
      source_data: { pan: '2346', sub_type: 'MasterCard', type: t.source_type ?? 'card' },
    };
    return { body: { type: 'TRANSACTION', obj }, hmac: paymobHmac(obj, secret) };
  }
}

/** Test-side controls for the shared contract suite. */
export function createPaymobControl(stub: PaymobStub): ContractControl {
  const deliver = (body: Record<string, unknown>, hmac: string): SignedWebhook => ({
    rawBody: JSON.stringify(body),
    headers: { [PAYMOB_HMAC_HEADER]: hmac },
  });
  const edit = (w: SignedWebhook, fn: (obj: Record<string, unknown>) => void): SignedWebhook => {
    const body = JSON.parse(w.rawBody) as { obj: Record<string, unknown> };
    fn(body.obj);
    return { ...w, rawBody: JSON.stringify(body) };
  };
  return {
    capture: providerRef => void stub.capture(Number(providerRef)),
    paymentWebhook: (providerRef, opts = {}) => {
      const order = stub.orders.get(Number(providerRef))!;
      const state =
        opts.state ?? (order.txnId && stub.txns.get(order.txnId)?.success ? 'paid' : 'pending');
      const existing = order.txnId ? stub.txns.get(order.txnId) : undefined;
      // A forced "different delivery" is a NEW transaction attempt on the same order.
      const id =
        opts.eventId || !existing
          ? 5000 +
            crypto
              .createHash('sha1')
              .update(opts.eventId ?? `${stub.requests.length}`)
              .digest()
              .readUInt16BE(0)
          : existing.id;
      const { body, hmac } = stub.callbackFor({
        id,
        orderId: order.id,
        amount_cents: opts.amountMinor ?? order.amount,
        success: state === 'paid',
        pending: state === 'pending',
        is_voided: false,
        is_refunded: false,
        integration_id: order.methods[0],
        // now, not a fixed date: the provider refuses a callback whose signed created_at is older than its window
        // (38 d), so the old '2026-10-04' constant expired on 2026-11-11 and turned the contract suite red on main
        created_at: existing?.created_at ?? new Date().toISOString(),
      });
      return deliver(body, hmac);
    },
    webhookStates: ['pending', 'failed'],
    badSignature: w => ({ ...w, headers: { [PAYMOB_HMAC_HEADER]: 'deadbeef' } }),
    noSignature: w => ({ ...w, headers: {} }),
    tamperAmount: (w, amountMinor) => edit(w, o => void (o.amount_cents = amountMinor)),
    tamperStatus: w => edit(w, o => void ((o.success = false), (o.error_occured = true))),
    injectNextCall: (fault: StubFault) => stub.faults.injectNextCall(fault),
    providerPaymentCount: () => stub.createdCount,
  };
}
