/**
 * Cash on delivery as a provider-shaped method (SP6a). No network: the courier
 * collects, the merchant marks the order paid.
 *
 * The COD fee (fixed + optional percentage, half-up to the piastre) is quoted
 * at checkout and FROZEN on the order at creation (`orders.cod_fee`, ruling
 * MONEYB-3) by `codFeeForOrder` — the same function the storefront quotes
 * with. Nothing here adds a fee any more: `/payments/create` only records what
 * the courier collects, `order.total − wallet`.
 */
import { storeDb } from '../../lib/repo-factory';
import { prisma } from '@ebda/database';
import { type CodFeeConfig } from '@ebda/shared';
import { assertChargeable } from './provider-call';
import {
  PaymentProviderError,
  type CreatePaymentV2Request,
  type CreatePaymentV2Result,
  type PaymentProviderV2,
  type ProviderCapabilities,
} from './types';

/** The fee settings of a COD `payment_configs` row (fixed piastres + percentage bps). */
export function codFeeConfigFromRow(row: {
  fixedFee: unknown;
  settings: unknown;
}): Required<CodFeeConfig> {
  const fixed = Number(row.fixedFee);
  const bps = Number((row.settings as { percentBps?: unknown } | null)?.percentBps ?? 0);
  return {
    fixedFee: Number.isFinite(fixed) && fixed > 0 ? Math.round(fixed) : 0,
    percentBps: Number.isFinite(bps) && bps > 0 ? Math.round(bps) : 0,
  };
}

/** The store's enabled COD fee settings, or null when COD is off. Store-scoped read. */
export async function loadCodFeeConfig(storeId: string): Promise<Required<CodFeeConfig> | null> {
  const row = await (
    await storeDb(storeId)
  ).paymentConfig.findFirst({
    where: { storeId, provider: 'cod', isEnabled: true },
    select: { fixedFee: true, settings: true },
  });
  return row ? codFeeConfigFromRow(row) : null;
}

/** What the courier collects for a COD order: its total (fee already inside) less the wallet part. */
export function codCollectMinor(orderTotalMinor: number, walletMinor = 0): number {
  return Math.max(0, orderTotalMinor - Math.max(0, walletMinor));
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
