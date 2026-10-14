/**
 * InstaPay as a provider-shaped MANUAL method (SP6a).
 *
 * InstaPay has no merchant API (docs/ebda/research/egypt-payment-providers.md):
 * the customer transfers to the merchant's InstaPay handle / phone and the
 * merchant confirms the money arrived. So this adapter makes no network call and
 * can never learn a payment succeeded; the ONLY way an InstaPay order becomes paid
 * is the merchant's confirm (`InstapayService.confirm`). The adapter only builds
 * what the customer is shown: the merchant's handle/phone, the exact amount in
 * piastres, and the order reference to quote.
 */
import { INSTAPAY_DEFAULT_EXPIRY_HOURS, instapaySettingsSchema } from '@ebda/shared';
import { assertChargeable } from './provider-call';
import {
  PaymentProviderError,
  type CreatePaymentV2Request,
  type CreatePaymentV2Result,
  type PaymentProviderV2,
  type ProviderCapabilities,
  type ProviderCredentials,
} from './types';

const capabilities: ProviderCapabilities = {
  methods: ['instapay'],
  instructions: ['manual-instructions'],
  currencies: ['EGP'],
  partialRefunds: false,
  refunds: false,
  webhooks: false,
  remoteStatus: false,
  savedCards: false,
};

export function parseInstapaySettings(settings: ProviderCredentials['settings']) {
  const parsed = instapaySettingsSchema.safeParse(settings ?? {});
  if (!parsed.success) {
    throw new PaymentProviderError(
      'PROVIDER_MISCONFIGURED',
      'InstaPay is not set up: add the merchant InstaPay handle or phone number'
    );
  }
  return parsed.data;
}

export const instapayProvider: PaymentProviderV2 = {
  name: 'instapay',
  capabilities,

  async createPayment(
    req: CreatePaymentV2Request,
    creds: ProviderCredentials
  ): Promise<CreatePaymentV2Result> {
    assertChargeable(req);
    const settings = parseInstapaySettings(creds.settings);
    const hours = settings.expiryHours ?? INSTAPAY_DEFAULT_EXPIRY_HOURS;
    const expiresAt = req.expiresAt ?? new Date(Date.now() + hours * 3_600_000);
    const reference = req.orderNumber ?? req.orderId;
    return {
      providerRef: `instapay_${req.idempotencyKey}`,
      instruction: {
        kind: 'manual-instructions',
        method: 'instapay',
        amountMinor: req.amountMinor,
        details: {
          handle: settings.handle ?? null,
          phone: settings.phone ?? null,
          accountName: settings.accountName ?? null,
          reference,
        },
        expiresAt,
      },
      status: 'pending',
      amountMinor: req.amountMinor,
      currency: 'EGP',
      metadata: { reference },
    };
  },

  verifyWebhook() {
    throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'InstaPay has no webhooks');
  },

  async getStatus() {
    throw new PaymentProviderError(
      'STATUS_NOT_SUPPORTED',
      'InstaPay has no status API: the merchant confirms the transfer'
    );
  },

  async refund() {
    throw new PaymentProviderError(
      'REFUND_NOT_SUPPORTED',
      'InstaPay refunds are made by the merchant outside the system'
    );
  },

  async partialRefund() {
    throw new PaymentProviderError(
      'REFUND_NOT_SUPPORTED',
      'InstaPay refunds are made by the merchant outside the system'
    );
  },
};
