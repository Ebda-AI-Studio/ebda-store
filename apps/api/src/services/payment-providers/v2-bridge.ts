/**
 * Puts a `PaymentProviderV2` adapter (Paymob, Kashier, Fawry) behind the `IPaymentProvider`
 * face the payment factory and `PaymentService` still use, so the checkout, the refund
 * ledger, the webhook pipeline and the circuit breaker all keep working unchanged while the
 * adapters speak the v2 contract (integer piastres, typed errors, instructions).
 *
 * One bridge instance = one merchant's decrypted credentials for one provider; the factory
 * builds it per (store, provider) and caches it for five minutes. The decrypted secrets live
 * in this closure only, never on a row, a log line or a response.
 */
import crypto from 'node:crypto';
import { ProviderRejectedError } from './refund-outcome';
import { enabledMethods, METHOD_LABELS } from './provider-methods';
import { signatureToHeaders } from './webhook-signature';
import {
  PaymentProviderError,
  type AvailablePaymentMethod,
  type CreatePaymentRequest,
  type Currency,
  type IPaymentProvider,
  type PaymentProvider,
  type PaymentProviderConfig,
  type PaymentProviderV2,
  type PaymentResponse,
  type PaymentStatusResponse,
  type ProviderCredentials,
  type RefundRequest,
  type RefundResponse,
  type WebhookConfirmation,
  type WebhookEventV2,
  type WebhookPayload,
} from './types';

/** Errors that say "the gateway answered, and the request is what it refused": nothing moved. */
const REFUSED = new Set([
  'PROVIDER_REJECTED',
  'AMOUNT_INVALID',
  'CURRENCY_UNSUPPORTED',
  'REFUND_EXCEEDS_CAPTURED',
  'REFUND_NOT_SUPPORTED',
  'PAYMENT_NOT_FOUND',
  'PAYMENT_NOT_CAPTURED',
  'PROVIDER_MISCONFIGURED',
]);

export class V2ProviderBridge implements IPaymentProvider {
  readonly name: PaymentProvider;

  constructor(
    private readonly adapter: PaymentProviderV2,
    private readonly creds: ProviderCredentials
  ) {
    this.name = adapter.name;
  }

  initialize(_config: PaymentProviderConfig): void {
    // Credentials arrive with the constructor; there is nothing to initialise.
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentResponse> {
    const key = request.metadata?.idempotencyKey ?? `${request.orderId}:${this.name}:1`;
    const res = await this.adapter.createPayment(
      {
        orderId: request.orderId,
        orderNumber: request.orderNumber,
        amountMinor: request.amount,
        currency: request.currency as 'EGP',
        customer: request.customer,
        returnUrls: { success: request.callbackUrl, failure: request.errorUrl },
        webhookUrl: request.webhookUrl,
        idempotencyKey: key,
        items: request.items,
        metadata: request.metadata,
      },
      this.creds
    );
    const redirect =
      res.instruction.kind === 'redirect' || res.instruction.kind === 'iframe'
        ? res.instruction.url
        : '';
    return {
      success: true,
      provider: this.name,
      transactionId: res.providerRef,
      invoiceId: res.invoiceId,
      paymentUrl: redirect,
      instruction: res.instruction,
      expiresAt: res.instruction.expiresAt,
      metadata: { ...res.metadata, instruction: res.instruction },
    };
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentStatusResponse> {
    const st = await this.adapter.getStatus(transactionId, this.creds);
    // #625: an answer with no amounts reports them as UNKNOWN (undefined), never 0. A 0 here was read downstream as "paid
    // nothing", so a captured Kashier order was held as underpaid forever; unknown lets the confirm path use the amount
    // the payment was created for (a server-side status query is authoritative for the state, CF-PAY rubric #12).
    const known = st.amountsKnown !== false;
    return {
      success: true,
      provider: this.name,
      transactionId,
      status: st.status,
      amount: st.amountMinor,
      currency: st.currency,
      paidAmount: known ? st.capturedMinor : undefined,
      paidCurrency: known ? st.currency : undefined,
      paymentMethod: st.method,
      paidAt: st.paidAt,
      refundedAmount: known ? st.refundedMinor : undefined,
    };
  }

  async refund(request: RefundRequest): Promise<RefundResponse> {
    // A fresh key per call: PaymentService's committed refund claim (and the refundKey it
    // enforces) is what stops a second refund for the same business event, not this key.
    const idempotencyKey = `refund:${request.transactionId}:${crypto.randomUUID()}`;
    try {
      const out =
        request.amount == null
          ? await this.adapter.refund(
              { providerRef: request.transactionId, idempotencyKey, reason: request.reason },
              this.creds
            )
          : await this.adapter.partialRefund(
              {
                providerRef: request.transactionId,
                idempotencyKey,
                reason: request.reason,
                amountMinor: request.amount,
              },
              this.creds
            );
      return {
        success: true,
        provider: this.name,
        refundId: out.refundRef,
        transactionId: request.transactionId,
        amount: out.amountMinor,
        status: out.status,
      };
    } catch (err) {
      // The gateway refused: PaymentService releases its claim and the merchant may retry.
      // A timeout / unreachable gateway is rethrown as it is: the refund MAY have executed.
      if (err instanceof PaymentProviderError && REFUSED.has(err.code)) {
        throw new ProviderRejectedError(err.message, 0);
      }
      throw err;
    }
  }

  verifyWebhook(): boolean {
    // v2 adapters verify over the RAW body: `verifyAndParseWebhook` is the only way in.
    return false;
  }

  verifyAndParseWebhook(rawBody: string, signature: string): WebhookPayload {
    const ev = this.adapter.verifyWebhook(
      rawBody,
      signatureToHeaders(this.name, signature),
      this.creds
    );
    return toWebhookPayload(this.name, ev);
  }

  /**
   * Present only when the adapter confirms deliveries server-to-server (Kashier). The
   * payload returned is built from the CONFIRMED event, so an unsigned label the delivery
   * carried (refund vs payment, authorize vs pay) never reaches the money pipeline.
   */
  get confirmWebhook():
    | ((
        payload: WebhookPayload
      ) => Promise<{ payload: WebhookPayload; confirmation: WebhookConfirmation }>)
    | undefined {
    const confirm = this.adapter.confirmWebhookEvent?.bind(this.adapter);
    if (!confirm) return undefined;
    return async (payload: WebhookPayload) => {
      if (!payload.v2Event) {
        // Every payload this bridge builds carries its event; one without it was not built here.
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'payload has no verified event');
      }
      const confirmation = await confirm(payload.v2Event, this.creds);
      return { payload: toWebhookPayload(this.name, confirmation.event), confirmation };
    };
  }

  parseWebhook(): WebhookPayload {
    throw new PaymentProviderError(
      'WEBHOOK_MALFORMED',
      'v2 adapters verify and parse in one step (verifyAndParseWebhook)'
    );
  }

  async getPaymentMethods(_amount: number, _currency: Currency): Promise<AvailablePaymentMethod[]> {
    return enabledMethods(this.name, this.creds.settings).map(code => ({
      id: code,
      code,
      name: METHOD_LABELS[code]?.name ?? code,
      nameAr: METHOD_LABELS[code]?.nameAr,
    }));
  }
}

/** The legacy pipeline's view of a verified v2 event. */
export function toWebhookPayload(name: PaymentProvider, ev: WebhookEventV2): WebhookPayload {
  if (ev.kind === 'refund') {
    return {
      provider: name,
      event: `refund.${ev.status}`,
      transactionId: ev.providerRef,
      invoiceId: ev.providerRef,
      status: 'refunded',
      amount: ev.amountMinor,
      currency: ev.currency,
      refund: {
        refundId: ev.refundRef,
        status: ev.status,
        // 0 = the gateway did not say how much: the pipeline then holds the balance for a human.
        amount: ev.amountMinor > 0 ? ev.amountMinor : undefined,
      },
      rawPayload: ev.rawPayload,
      v2Event: ev,
    };
  }
  return {
    provider: name,
    event: ev.eventId,
    transactionId: ev.providerRef,
    invoiceId: ev.providerRef,
    status: ev.status,
    amount: ev.amountMinor,
    currency: ev.currency,
    paymentMethod: ev.method,
    paidAt: ev.paidAt,
    rawPayload: ev.rawPayload,
    v2Event: ev,
  };
}
