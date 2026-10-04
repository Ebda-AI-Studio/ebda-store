/**
 * Cash on delivery as a provider-shaped method (SP6a). No network: the courier
 * collects, the merchant marks the order paid. Existing COD behaviour is kept
 * exactly: the fee is `codFeeMinor` (fixed + optional percentage, half-up to the
 * piastre), added to the order total ONCE (a replayed create never stacks it),
 * and the courier collects `total + fee - wallet`.
 */
import { codFeeMinor } from '@force/shared';
import { assertChargeable } from './provider-call';
import {
  PaymentProviderError,
  type CreatePaymentV2Request,
  type CreatePaymentV2Result,
  type PaymentProviderV2,
  type ProviderCapabilities,
} from './types';

export interface CodChargeInput {
  /** `order.total` as stored (already includes the fee if it was applied before). */
  orderTotalMinor: number;
  /** Customer-wallet portion, piastres. */
  walletMinor?: number;
  fixedFeeMinor: number;
  percentBps?: number;
  /** A COD payment row already exists for the order, so the fee is already folded into `orderTotalMinor`. */
  feeAlreadyApplied: boolean;
}

export interface CodCharge {
  feeMinor: number;
  /** New `order.total` (fee folded in once). */
  chargedTotalMinor: number;
  /** What the courier collects. */
  collectMinor: number;
  /** Whether `order.total` must be updated. */
  applyFee: boolean;
}

/**
 * The COD arithmetic of `/payments/create`, extracted so the fee, the replay
 * guard and the wallet split are one tested function. Integer piastres only.
 */
export function computeCodCharge(input: CodChargeInput): CodCharge {
  const feeMinor = codFeeMinor(input.orderTotalMinor, {
    fixedMinor: input.fixedFeeMinor,
    percentBps: input.percentBps,
  });
  const applyFee = feeMinor > 0 && !input.feeAlreadyApplied;
  const chargedTotalMinor = applyFee ? input.orderTotalMinor + feeMinor : input.orderTotalMinor;
  return {
    feeMinor,
    chargedTotalMinor,
    collectMinor: chargedTotalMinor - (input.walletMinor ?? 0),
    applyFee,
  };
}

const capabilities: ProviderCapabilities = {
  methods: ['cod'],
  instructions: ['manual-instructions'],
  currencies: ['EGP'],
  partialRefunds: false,
  refunds: false,
  webhooks: false,
  remoteStatus: false,
  savedCards: false,
};

const notSupported = (what: string) =>
  new PaymentProviderError('REFUND_NOT_SUPPORTED', `Cash on delivery has no provider ${what}`);

export const codProvider: PaymentProviderV2 = {
  name: 'cod',
  capabilities,

  async createPayment(req: CreatePaymentV2Request): Promise<CreatePaymentV2Result> {
    assertChargeable(req);
    return {
      // Deterministic per key: a repeat is the same payment, with no state held here.
      providerRef: `cod_${req.idempotencyKey}`,
      instruction: {
        kind: 'manual-instructions',
        method: 'cod',
        amountMinor: req.amountMinor,
        details: { reference: req.orderNumber ?? req.orderId },
      },
      status: 'cod_pending',
      amountMinor: req.amountMinor,
      currency: 'EGP',
    };
  },

  verifyWebhook() {
    // COD has no provider and therefore no webhook: nothing can ever be verified.
    throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'Cash on delivery has no webhooks');
  },

  async getStatus() {
    throw new PaymentProviderError(
      'STATUS_NOT_SUPPORTED',
      'Cash on delivery has no provider status'
    );
  },

  async refund() {
    throw notSupported('refund');
  },

  async partialRefund() {
    throw notSupported('partial refund');
  },
};
