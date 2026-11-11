/**
 * Where each gateway puts its webhook signature, and how its webhook names the payment
 * (SP6b). The webhook route needs both BEFORE the adapter runs: the signature to refuse an
 * unsigned call, the references to find the owning store (through the
 * `ebda_webhook_resolve_store_scoped` definer) and the inbox idempotency key.
 *
 *   Paymob   `?hmac=` query parameter       (HMAC-SHA512 over 20 callback fields)
 *   Kashier  `x-kashier-signature` header   (HMAC-SHA256 over the signed keys)
 *   Fawry    `messageSignature` in the BODY (SHA-256 with the secure key appended)
 *
 * Everything extracted here is read from an UNVERIFIED body: it only routes and dedupes. The
 * adapter's `verifyWebhook` is what decides whether the delivery is believed.
 */
import { KASHIER_SIGNATURE_HEADER } from './kashier.provider';
import { PAYMOB_HMAC_HEADER, paymobCanonicalState } from './paymob.provider';
import type { WebhookHeaders } from './types';

export interface WebhookRefs {
  /** Inbox dedupe key; null when the body does not carry what is needed to build one. */
  idempotencyKey: string | null;
  /** Earlier key shapes for the same delivery, checked when deduping (already-stored rows). */
  legacyIdempotencyKeys?: string[];
  /** Matches `Payment.transactionId` (the provider reference). */
  transactionId: string | null;
  /** Matches `Payment.invoiceId`. */
  invoiceId: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The gateways whose webhooks this route accepts. Every one must also have a case in the
 * extractors below; tests/unit/provider-catalog.test.ts asserts the list equals the catalog's
 * non-manual payment providers, so a catalog entry cannot ship without its webhook wiring.
 */
// geidea: listed so its route exists, but its callback signature is undocumented: it carries NO
// extractable signature (-> 401 MISSING_SIGNATURE) and its adapter refuses every delivery.
export const GATEWAY_WEBHOOK_PROVIDERS = ['paymob', 'kashier', 'fawry', 'geidea'] as const;
export type GatewayWebhookProvider = (typeof GATEWAY_WEBHOOK_PROVIDERS)[number];

export function isGatewayWebhookProvider(p: string): p is GatewayWebhookProvider {
  return (GATEWAY_WEBHOOK_PROVIDERS as readonly string[]).includes(p);
}

/** The signature as the gateway sent it ('' when absent). */
export function extractWebhookSignature(
  provider: string,
  req: { query: Record<string, unknown>; headers: Record<string, unknown> },
  body: Record<string, unknown>
): string {
  switch (provider) {
    case 'paymob': {
      const q = req.query.hmac;
      return typeof q === 'string' ? q : '';
    }
    case 'kashier': {
      const h = req.headers[KASHIER_SIGNATURE_HEADER];
      return typeof h === 'string' ? h : '';
    }
    case 'fawry':
      return typeof body.messageSignature === 'string' ? body.messageSignature : '';
    default:
      return '';
  }
}

/** The headers the adapter's `verifyWebhook` reads the signature from. */
export function signatureToHeaders(provider: string, signature: string): WebhookHeaders {
  switch (provider) {
    case 'paymob':
      return { [PAYMOB_HMAC_HEADER]: signature };
    case 'kashier':
      return { [KASHIER_SIGNATURE_HEADER]: signature };
    default:
      return {};
  }
}

export function webhookRefs(provider: string, payload: Record<string, unknown>): WebhookRefs {
  switch (provider) {
    case 'paymob': {
      const o = obj(payload.obj);
      const order = obj(o.order);
      const id = str(o.id);
      // Canonical signed state, read as the HMAC text reads it (a string "true" == true).
      const st = paymobCanonicalState(o);
      const base = id ? `paymob_${id}_${st.flags}` : null;
      return {
        idempotencyKey: base ? `${base}${st.parent ? '_p' : ''}` : null,
        // A child (refund/void) callback used to share the parent-less key: still dedupe on it.
        legacyIdempotencyKeys: base && st.parent ? [base] : [],
        transactionId: str(order.id),
        invoiceId: str(order.merchant_order_id),
      };
    }
    case 'kashier': {
      const d = obj(payload.data);
      const order = str(d.merchantOrderId);
      return {
        idempotencyKey: order
          ? `kashier_${order}_${str(d.status) ?? ''}_${str(d.transactionId) ?? ''}`
          : null,
        transactionId: order,
        invoiceId: null,
      };
    }
    case 'fawry': {
      const ref = str(payload.fawryRefNumber);
      return {
        idempotencyKey: ref ? `fawry_${ref}_${str(payload.orderStatus) ?? ''}` : null,
        transactionId: str(payload.merchantRefNumber),
        invoiceId: ref,
      };
    }
    default:
      return { idempotencyKey: null, transactionId: null, invoiceId: null };
  }
}

/** Which gateway sent an unlabelled delivery to the generic `/webhooks/payment` route. */
export function detectGatewayProvider(
  payload: Record<string, unknown>
): GatewayWebhookProvider | null {
  if (payload.type === 'TRANSACTION' && payload.obj && typeof payload.obj === 'object')
    return 'paymob';
  if (
    payload.data &&
    typeof payload.data === 'object' &&
    'signatureKeys' in (payload.data as object)
  ) {
    return 'kashier';
  }
  if (typeof payload.fawryRefNumber === 'string') return 'fawry';
  return null;
}

/**
 * A Fawry REFUND notice (`REFUNDED` / `PARTIALLY_REFUNDED`). When its dedupe key repeats, the route raises a P1 instead of
 * dropping it silently: Fawry does not sign the refund amount, and nothing proves `paymentRefrenceNumber` changes per refund,
 * so a repeat may be a SECOND partial refund that looks identical to the first (Ruling FAWRY-REFUND-DEDUPE-1). Paymob and
 * Kashier refunds are their own transactions with their own ids, so a repeat there is a real redelivery.
 */
export function isFawryRefundNotice(provider: string, payload: Record<string, unknown>): boolean {
  if (provider !== 'fawry') return false;
  const status = typeof payload.orderStatus === 'string' ? payload.orderStatus.toUpperCase() : '';
  return status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED';
}
