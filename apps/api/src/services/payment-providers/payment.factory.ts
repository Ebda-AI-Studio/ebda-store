import crypto from 'crypto';
import { prisma, Prisma, runInTenantContext } from '@force/database';
import { config } from '../../config';
import { AppError } from '../../middleware/error-handler';
import logger from '../../lib/logger';
import { encryption } from '../encryption.service';
import { OrderService, assertValidTransition } from '../order.service';
import { socketService } from '../socket.service';
import { inngest } from '../../lib/inngest/client';
import { OneSignalService } from '../onesignal.service';
import { redis } from '../redis.service';
import { sendAlert } from '../alerts.service';
import { alertUnbookedRefund } from './unbooked-refund-alert';
import { recordPaymentEvent } from '../payment-event.service';
import { invalidateCustomersCache } from '../../lib/public-cache';
import { buildPaymentLineItems } from '../../lib/payment-line-items';
import {
  IPaymentProvider,
  PaymentProvider,
  CreatePaymentRequest,
  PaymentResponse,
  PaymentStatusResponse,
  RefundRequest,
  RefundResponse,
  AvailablePaymentMethod,
  Currency,
} from './types';
import { TapPaymentProvider } from './tap.provider';
import { MyFatoorahPaymentProvider } from './myfatoorah.provider';
import { HesabePaymentProvider } from './hesabe.provider';
import { UPaymentsProvider } from './upayments.provider';
import {
  resolveRefundSettlement,
  readAccountedRefundEventIds,
  appendRefundEventId,
  REFUND_EVENT_IDS_KEY,
  REFUND_STATUS_BY_ID_KEY,
  isRefundEventAlreadySeen,
  recordRefundStatus,
} from './refund-settlement';
import {
  ProviderRejectedError,
  markRefundMayHaveExecuted,
  REFUND_CLAIM_EVENT,
  REFUND_EXECUTED_EVENT,
  REFUND_RELEASED_EVENT,
  REFUND_INDETERMINATE_EVENT,
  REFUND_RECONCILED_EVENT,
} from './refund-outcome';

// ==========================================
// Payment Factory
// Database-driven configuration for Kuwait payment providers
// Supports both global and per-store configurations
// ==========================================

/** Money-integrity F3 (2026-07-02 audit): reconciliation tolerance (fils)
 *  for a provider-reported paid amount vs the expected `Payment.amount`.
 *  See the `isAmountUnderpaid` check in `handleWebhook` for the unit
 *  verification note (both sides are fils; every provider's
 *  parseWebhook/getPaymentStatus round-trips via `Math.round(x * 1000)`). */
const AMOUNT_TOLERANCE_FILS = 5;

interface ProviderConfig {
  provider: PaymentProvider;
  apiKey: string;
  secretKey?: string;
  merchantId?: string;
  webhookSecret?: string;
  isTestMode: boolean;
  isEnabled: boolean;
  isDefault: boolean;
  displayName?: string;
  displayNameAr?: string;
  supportedMethods: string[];
  supportedCurrencies: string[];
  fixedFee: number;
  percentageFee: number;
}

interface CachedProviders {
  providers: Map<PaymentProvider, IPaymentProvider>;
  defaultProvider: PaymentProvider | null;
  configs: Map<PaymentProvider, ProviderConfig>;
  timestamp: number;
}

class PaymentFactory {
  // Cache providers by storeId (null = global)
  private cache: Map<string | null, CachedProviders> = new Map();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes
  private initializationPromises: Map<string | null, Promise<void>> = new Map();

  /**
   * Get or initialize providers for a store (or global if storeId is null)
   */
  async getProviders(storeId?: string | null): Promise<CachedProviders> {
    const cacheKey = storeId || null;
    const cached = this.cache.get(cacheKey);

    // Return cached if valid
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached;
    }

    // Check if already initializing to prevent concurrent initialization
    const existingPromise = this.initializationPromises.get(cacheKey);
    if (existingPromise) {
      await existingPromise;
      return this.cache.get(cacheKey)!;
    }

    // Initialize providers
    const initPromise = this.initializeProviders(cacheKey);
    this.initializationPromises.set(cacheKey, initPromise);

    try {
      await initPromise;
      return this.cache.get(cacheKey)!;
    } finally {
      this.initializationPromises.delete(cacheKey);
    }
  }

  /**
   * Initialize providers from database configuration
   */
  private async initializeProviders(storeId: string | null): Promise<void> {
    const providers = new Map<PaymentProvider, IPaymentProvider>();
    const configs = new Map<PaymentProvider, ProviderConfig>();
    let defaultProvider: PaymentProvider | null = null;

    try {
      // First try to get store-specific config, then fall back to global
      let dbConfigs = await prisma.paymentConfig.findMany({
        where: {
          storeId: storeId,
          isEnabled: true,
        },
        orderBy: { provider: 'asc' },
      });

      // If no store-specific config, try global config
      if (dbConfigs.length === 0 && storeId !== null) {
        dbConfigs = await prisma.paymentConfig.findMany({
          where: {
            storeId: null,
            isEnabled: true,
          },
          orderBy: { provider: 'asc' },
        });
      }

      // Fall back to environment variables ONLY for platform-level lookups
      // (storeId === null). For any specific store, providers must come from
      // a paymentConfig row created via admin settings — otherwise a globally-
      // set TAP_API_KEY env var would leak Tap as "available" to every tenant
      // even though they never enabled it. Per-store configuration is the
      // explicit requirement; don't reintroduce a cross-tenant fallback.
      if (dbConfigs.length === 0 && storeId === null) {
        logger.info('[PAYMENT] No database config found, using environment variables');
        this.initializeFromEnv(providers, configs);
      } else if (dbConfigs.length === 0) {
        logger.info(
          { storeId },
          '[PAYMENT] No paymentConfig rows for store; no online providers available'
        );
      } else {
        // Initialize from database config
        for (const dbConfig of dbConfigs) {
          try {
            const providerConfig: ProviderConfig = {
              provider: dbConfig.provider as PaymentProvider,
              apiKey: dbConfig.apiKey ? encryption.decrypt(dbConfig.apiKey) : '',
              secretKey: dbConfig.secretKey ? encryption.decrypt(dbConfig.secretKey) : undefined,
              merchantId: dbConfig.merchantId ? encryption.decrypt(dbConfig.merchantId) : undefined,
              webhookSecret: dbConfig.webhookSecret
                ? encryption.decrypt(dbConfig.webhookSecret)
                : undefined,
              isTestMode: dbConfig.testMode,
              isEnabled: dbConfig.isEnabled,
              isDefault: dbConfig.isDefault,
              displayName: dbConfig.displayName || undefined,
              displayNameAr: dbConfig.displayNameAr || undefined,
              supportedMethods: dbConfig.supportedMethods,
              supportedCurrencies: dbConfig.supportedCurrencies,
              fixedFee: Number(dbConfig.fixedFee),
              percentageFee: Number(dbConfig.percentageFee),
            };

            if (!providerConfig.apiKey) {
              logger.warn(
                { provider: dbConfig.provider },
                '[PAYMENT] Skipping provider: No API key configured'
              );
              continue;
            }

            const provider = this.createProvider(providerConfig);
            if (provider) {
              providers.set(providerConfig.provider, provider);
              configs.set(providerConfig.provider, providerConfig);

              if (dbConfig.isDefault) {
                defaultProvider = providerConfig.provider;
              }
            }
          } catch (error) {
            logger.error(
              { err: error, provider: dbConfig.provider },
              '[PAYMENT] Failed to initialize provider'
            );
          }
        }
      }

      // Set default provider if not explicitly set
      if (!defaultProvider && providers.size > 0) {
        defaultProvider = providers.keys().next().value || null;
      }

      logger.info(
        {
          storeId,
          providers: Array.from(providers.keys()).join(', ') || 'none',
          defaultProvider: defaultProvider || 'none',
        },
        '[PAYMENT] Initialized providers'
      );

      this.cache.set(storeId, {
        providers,
        configs,
        defaultProvider,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error({ err: error }, '[PAYMENT] Failed to initialize providers');

      // Initialize from env as fallback
      this.initializeFromEnv(providers, configs);

      if (providers.size > 0) {
        defaultProvider = providers.keys().next().value || null;
      }

      this.cache.set(storeId, {
        providers,
        configs,
        defaultProvider,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Initialize from environment variables (fallback)
   */
  private initializeFromEnv(
    providers: Map<PaymentProvider, IPaymentProvider>,
    configs: Map<PaymentProvider, ProviderConfig>
  ): void {
    // Initialize Tap Payments
    if (config.tapApiKey) {
      const providerConfig: ProviderConfig = {
        provider: 'tap',
        apiKey: config.tapApiKey,
        secretKey: config.tapSecretKey,
        webhookSecret: config.tapWebhookSecret,
        isTestMode: config.paymentTestMode,
        isEnabled: true,
        isDefault: true,
        supportedMethods: ['knet', 'visa', 'mastercard', 'apple_pay'],
        supportedCurrencies: ['KWD', 'USD', 'SAR', 'AED', 'BHD'],
        fixedFee: 0,
        percentageFee: 2.5,
      };
      const tap = this.createProvider(providerConfig);
      if (tap) {
        providers.set('tap', tap);
        configs.set('tap', providerConfig);
      }
    }

    // Initialize MyFatoorah
    if (config.myfatoorahApiKey) {
      const providerConfig: ProviderConfig = {
        provider: 'myfatoorah',
        apiKey: config.myfatoorahApiKey,
        webhookSecret: config.myfatoorahWebhookSecret || undefined,
        isTestMode: config.paymentTestMode,
        isEnabled: true,
        isDefault: false,
        supportedMethods: ['knet', 'visa', 'mastercard'],
        supportedCurrencies: ['KWD', 'USD', 'SAR', 'AED', 'BHD'],
        fixedFee: 0,
        percentageFee: 2.0,
      };
      const myfatoorah = this.createProvider(providerConfig);
      if (myfatoorah) {
        providers.set('myfatoorah', myfatoorah);
        configs.set('myfatoorah', providerConfig);
      }
    }

    // Initialize Hesabe
    if (config.hesabeApiKey) {
      const providerConfig: ProviderConfig = {
        provider: 'hesabe',
        apiKey: config.hesabeApiKey,
        secretKey: config.hesabeSecretKey,
        merchantId: config.hesabeMerchantId,
        webhookSecret: config.hesabeWebhookSecret,
        isTestMode: config.paymentTestMode,
        isEnabled: true,
        isDefault: false,
        supportedMethods: ['knet', 'visa', 'mastercard'],
        supportedCurrencies: ['KWD'],
        fixedFee: 0,
        percentageFee: 2.5,
      };
      const hesabe = this.createProvider(providerConfig);
      if (hesabe) {
        providers.set('hesabe', hesabe);
        configs.set('hesabe', providerConfig);
      }
    }

    // Initialize UPayments
    if (config.upaymentsApiKey) {
      const providerConfig: ProviderConfig = {
        provider: 'upayments',
        apiKey: config.upaymentsApiKey,
        secretKey: config.upaymentsSecretKey,
        merchantId: config.upaymentsMerchantId,
        webhookSecret: config.upaymentsWebhookSecret,
        isTestMode: config.paymentTestMode,
        isEnabled: true,
        isDefault: false,
        supportedMethods: ['knet', 'visa', 'mastercard', 'apple_pay', 'samsung_pay'],
        supportedCurrencies: ['KWD'],
        fixedFee: 0,
        percentageFee: 2.5,
      };
      const upayments = this.createProvider(providerConfig);
      if (upayments) {
        providers.set('upayments', upayments);
        configs.set('upayments', providerConfig);
      }
    }
  }

  /**
   * Create a provider instance from config
   */
  private createProvider(config: ProviderConfig): IPaymentProvider | null {
    try {
      let provider: IPaymentProvider;

      switch (config.provider) {
        case 'tap':
          provider = new TapPaymentProvider();
          provider.initialize({
            apiKey: config.apiKey,
            secretKey: config.secretKey,
            baseUrl: '',
            isTestMode: config.isTestMode,
            webhookSecret: config.webhookSecret,
          });
          break;

        case 'myfatoorah':
          provider = new MyFatoorahPaymentProvider();
          provider.initialize({
            apiKey: config.apiKey,
            baseUrl: '',
            isTestMode: config.isTestMode,
            webhookSecret: config.webhookSecret,
          });
          break;

        case 'hesabe':
          provider = new HesabePaymentProvider();
          provider.initialize({
            apiKey: config.apiKey,
            secretKey: config.secretKey,
            merchantId: config.merchantId,
            baseUrl: '',
            isTestMode: config.isTestMode,
            webhookSecret: config.webhookSecret,
          });
          break;

        case 'upayments':
          provider = new UPaymentsProvider();
          provider.initialize({
            apiKey: config.apiKey,
            secretKey: config.secretKey,
            merchantId: config.merchantId,
            baseUrl: '',
            isTestMode: config.isTestMode,
            webhookSecret: config.webhookSecret,
          });
          break;

        default:
          logger.warn({ provider: config.provider }, '[PAYMENT] Unknown provider');
          return null;
      }

      return provider;
    } catch (error) {
      logger.error(
        { err: error, provider: config.provider },
        '[PAYMENT] Failed to create provider'
      );
      return null;
    }
  }

  /**
   * Get a specific provider
   */
  async getProvider(
    provider?: PaymentProvider,
    storeId?: string | null
  ): Promise<IPaymentProvider> {
    const cached = await this.getProviders(storeId);
    const providerName = provider || cached.defaultProvider;

    if (!providerName) {
      throw new AppError(500, 'PAYMENT_NOT_CONFIGURED', 'No payment providers configured');
    }

    const p = cached.providers.get(providerName);

    if (!p) {
      throw new AppError(
        500,
        'PAYMENT_PROVIDER_NOT_CONFIGURED',
        `Payment provider '${providerName}' is not configured`
      );
    }

    return p;
  }

  /**
   * Get provider configuration
   */
  async getProviderConfig(
    provider: PaymentProvider,
    storeId?: string | null
  ): Promise<ProviderConfig | undefined> {
    const cached = await this.getProviders(storeId);
    return cached.configs.get(provider);
  }

  /**
   * Get available providers for a store
   */
  async getAvailableProviders(storeId?: string | null): Promise<PaymentProvider[]> {
    const cached = await this.getProviders(storeId);
    return Array.from(cached.providers.keys());
  }

  /**
   * Check if a provider is available
   */
  async isProviderAvailable(provider: PaymentProvider, storeId?: string | null): Promise<boolean> {
    const cached = await this.getProviders(storeId);
    return cached.providers.has(provider);
  }

  /**
   * Clear cache for a store (call when config changes)
   */
  clearCache(storeId?: string | null): void {
    if (storeId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(storeId);
    }
  }

  /**
   * Get default provider for a store
   */
  async getDefaultProvider(storeId?: string | null): Promise<PaymentProvider | null> {
    const cached = await this.getProviders(storeId);
    return cached.defaultProvider;
  }
}

// Singleton instance
const factory = new PaymentFactory();

/**
 * Duplicate-capture detector (adversarial audit P2): when a payment reaches a
 * captured state and ANOTHER payment on the same order is already captured
 * (completed / refunded / partially_refunded), real money was taken twice for
 * one order — e.g. two live invoices from a replayed /payments/create, both
 * paid. Nothing reconciled that combination before; the merchant found out
 * via a chargeback. Fires a P0 alert so finance refunds the duplicate before
 * the customer disputes. Best-effort by design: called with `await` but every
 * failure is swallowed — an alerting hiccup must never fail webhook
 * processing.
 */
export async function alertIfDuplicateCapture(
  paymentId: string,
  orderId: string,
  provider: string
): Promise<void> {
  try {
    const duplicate = await prisma.payment.findFirst({
      where: {
        orderId,
        id: { not: paymentId },
        status: { in: ['completed', 'refunded', 'partially_refunded'] },
      },
      select: { id: true, provider: true, amount: true },
    });
    if (!duplicate) return;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { storeId: true, store: { select: { name: true } } },
    });
    logger.error(
      { orderId, paymentId, duplicatePaymentId: duplicate.id, provider },
      '[PAYMENT WEBHOOK] duplicate capture detected — two captured payments on one order'
    );
    await sendAlert({
      level: 'p0',
      scope: 'store',
      store: {
        id: order?.storeId ?? '',
        name: order?.store?.name ?? order?.storeId ?? 'unknown',
      },
      source: 'payment.duplicate_capture',
      title: 'payment.duplicate_capture',
      body: `Order ${orderId}: payment ${paymentId} (${provider}) completed while payment ${duplicate.id} (${duplicate.provider}, ${duplicate.amount} fils) is already captured. The customer likely paid twice — refund the duplicate before it becomes a dispute.`,
      context: { orderId, paymentId, duplicatePaymentId: duplicate.id, provider },
    });
  } catch (err) {
    logger.error({ err, orderId, paymentId }, '[PAYMENT WEBHOOK] duplicate-capture check failed');
  }
}

// ==========================================
// Refund ledger (payment_events)
// ==========================================

/**
 * Run `fn` in a transaction of its own that commits when `fn` resolves —
 * whatever later happens to the caller's request transaction. Inside it the
 * `prisma` proxy routes to the new transaction, with the store's RLS GUC set.
 * See PaymentService.refund for why the refund's records cannot share the
 * request's fate.
 */
function commitOnOwnTransaction<T>(storeId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return runInTenantContext(storeId, fn);
}

/**
 * Claim ids for `refundKey` on this payment that were never released — each is
 * a refund that went out, or may have. A released claim (the provider refused,
 * or the request was never sent) does not count.
 */
export async function findOutstandingRefundClaims(
  paymentId: string,
  refundKey: string
): Promise<string[]> {
  const rows = await prisma.paymentEvent.findMany({
    where: {
      paymentId,
      eventType: { in: [REFUND_CLAIM_EVENT, REFUND_RELEASED_EVENT] },
      details: { path: ['refundKey'], equals: refundKey },
    },
    select: { eventType: true, details: true },
  });
  const claimed = new Set<string>();
  const released = new Set<string>();
  for (const row of rows) {
    const id = (row.details as Record<string, unknown> | null)?.claimId;
    if (typeof id !== 'string') continue;
    (row.eventType === REFUND_CLAIM_EVENT ? claimed : released).add(id);
  }
  return [...claimed].filter(id => !released.has(id));
}

/**
 * Mark every still-open claim for `refundKey` on this order as settled by the
 * merchant (issue 2002). Called when a return is completed with a NON-gateway
 * method — the product's own recovery for an indeterminate refund ("Already
 * refunded — record only"). Without it the claim had no terminal state a human
 * could reach, and the stuck-claim sweep re-alerted it for a week.
 *
 * "Open" = claimed, and not yet executed, released or reconciled. Written on
 * the caller's (request) transaction, so it commits or rolls back with the
 * completion it records. Moves no money. Returns the claim ids it settled.
 */
export async function reconcileOutstandingRefundClaims(input: {
  storeId: string;
  orderId: string;
  refundKey: string;
  refundMethod: string;
  userId?: string | null;
}): Promise<string[]> {
  const rows = await prisma.paymentEvent.findMany({
    where: {
      orderId: input.orderId,
      storeId: input.storeId,
      eventType: {
        in: [
          REFUND_CLAIM_EVENT,
          REFUND_EXECUTED_EVENT,
          REFUND_RELEASED_EVENT,
          REFUND_RECONCILED_EVENT,
        ],
      },
      details: { path: ['refundKey'], equals: input.refundKey },
    },
    select: { eventType: true, details: true, paymentId: true, provider: true },
  });
  const claims = new Map<string, { paymentId: string; provider: string | null; amount: unknown }>();
  const closed = new Set<string>();
  for (const row of rows) {
    const d = (row.details as Record<string, unknown> | null) ?? {};
    const id = d.claimId;
    if (typeof id !== 'string') continue;
    if (row.eventType === REFUND_CLAIM_EVENT) {
      claims.set(id, { paymentId: row.paymentId, provider: row.provider, amount: d.amount });
    } else {
      closed.add(id);
    }
  }
  const open = [...claims].filter(([id]) => !closed.has(id));
  for (const [claimId, claim] of open) {
    await prisma.paymentEvent.create({
      data: {
        paymentId: claim.paymentId,
        storeId: input.storeId,
        orderId: input.orderId,
        eventType: REFUND_RECONCILED_EVENT,
        provider: claim.provider,
        // The actor rides in `details`, not the `triggeredByUserId` FK: a
        // bad FK here would abort the completion transaction this row is
        // recording (25P02) and take the return down with it.
        details: {
          reason: 'reconciled_by_merchant',
          claimId,
          amount: typeof claim.amount === 'number' ? claim.amount : null,
          refundKey: input.refundKey,
          refundMethod: input.refundMethod,
          reconciledBy: input.userId ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }
  return open.map(([id]) => id);
}

// ==========================================
// Unified Payment Service
// ==========================================

export class PaymentService {
  /**
   * Get available payment providers
   */
  static async getAvailableProviders(storeId?: string): Promise<PaymentProvider[]> {
    return factory.getAvailableProviders(storeId);
  }

  /**
   * Resolve the merchant's default payment provider for the given store.
   * Honors per-store PaymentProviderConfig.isEnabled + falls back to env
   * defaults via the same logic as `createPayment(undefined, storeId)`.
   * Returns null when no provider is configured (caller surfaces a
   * "configure a provider in Settings → Payments" error).
   *
   * Used by merchant-initiated flows (WhatsApp payment links, manual
   * refunds, etc.) that need to know the provider name BEFORE calling
   * createPayment — typically to build the provider-specific webhook URL.
   */
  static async getDefaultProvider(storeId?: string | null): Promise<PaymentProvider | null> {
    const cached = await factory.getProviders(storeId);
    return cached.defaultProvider ?? null;
  }

  /**
   * Get payment methods for a specific provider
   */
  static async getPaymentMethods(
    amount: number,
    currency: Currency = 'KWD',
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<
    { provider: PaymentProvider; methods: AvailablePaymentMethod[]; config?: ProviderConfig }[]
  > {
    const providers = provider ? [provider] : await factory.getAvailableProviders(storeId);
    const results: {
      provider: PaymentProvider;
      methods: AvailablePaymentMethod[];
      config?: ProviderConfig;
    }[] = [];

    for (const p of providers) {
      try {
        const providerInstance = await factory.getProvider(p, storeId);
        const methods = await providerInstance.getPaymentMethods(amount, currency);
        const providerConfig = await factory.getProviderConfig(p, storeId);
        results.push({ provider: p, methods, config: providerConfig });
      } catch (error) {
        logger.error(
          { err: error, provider: p },
          '[PAYMENT] Failed to get payment methods from provider'
        );
      }
    }

    return results;
  }

  /**
   * Create a payment
   */
  static async createPayment(
    request: CreatePaymentRequest,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<PaymentResponse> {
    const p = await factory.getProvider(provider, storeId);
    const response = await p.createPayment(request);

    // Store payment record in database
    const payment = await prisma.payment.create({
      data: {
        orderId: request.orderId,
        provider: p.name,
        method: null, // Will be set when payment is completed via webhook
        amount: request.amount,
        currency: request.currency,
        status: 'pending',
        transactionId: response.transactionId,
        invoiceId: response.invoiceId,
        paymentUrl: response.paymentUrl,
        metadata: {
          provider: p.name,
          invoiceId: response.invoiceId,
          paymentUrl: response.paymentUrl,
          ...response.metadata,
        },
      },
      include: { order: { select: { storeId: true } } },
    });

    // Append-only audit row — see payment-event.service.ts
    await recordPaymentEvent({
      paymentId: payment.id,
      storeId: payment.order.storeId,
      orderId: payment.orderId,
      eventType: 'created',
      toStatus: 'pending',
      provider: p.name,
      details: {
        amount: request.amount,
        currency: request.currency,
        transactionId: response.transactionId,
        invoiceId: response.invoiceId,
      },
    });

    return response;
  }

  /**
   * Get payment status
   */
  static async getPaymentStatus(
    transactionId: string,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<PaymentStatusResponse> {
    // Try to find the payment in database to get the provider
    const payment = await prisma.payment.findFirst({
      where: { transactionId },
      include: { order: { include: { store: true } } },
    });

    const providerName = provider || (payment?.provider as PaymentProvider) || 'tap';
    const effectiveStoreId = storeId || payment?.order?.storeId;
    return (await factory.getProvider(providerName, effectiveStoreId)).getPaymentStatus(
      transactionId
    );
  }

  /**
   * Get refund status — looks up a previously-submitted refund's current
   * state at the provider. Used by the manual "Refresh refund status"
   * button on the admin order detail page when the refund webhook didn't
   * arrive or the merchant wants to confirm execution.
   */
  static async getRefundStatus(
    refundId: string,
    provider: PaymentProvider,
    storeId: string
  ): Promise<import('./types').RefundStatusResponse> {
    const p = await factory.getProvider(provider, storeId);
    if (!p.getRefundStatus) {
      throw new AppError(400, 'NOT_SUPPORTED', `${provider} does not support refund status lookup`);
    }
    return p.getRefundStatus(refundId);
  }

  /**
   * Process refund
   *
   * TRANSACTION BOUNDARIES. Every write this method makes about the money —
   * the claim before the provider call, the release or the indeterminate mark
   * after a failure, the confirmation after success — COMMITS ON ITS OWN, in a
   * transaction opened here (`commitOnOwnTransaction`), never on the caller's.
   *
   * Both HTTP callers (`POST /returns/admin/:id/complete`, the order page's
   * `refund-via-provider`) run inside the request's tenant transaction, which
   * commits only when the response is < 500. The provider call is not part of
   * that transaction and cannot be rolled back, so a record of it that lives
   * there is lost exactly when it matters: any 5xx after the refund went out
   * (an Inngest enqueue blip in the fanout, a failed completion write) rolled
   * back the claim, the status flip and the refund id together, leaving money
   * at the customer and a payment that still read as refundable — the retry
   * refunded again. Committing each step separately keeps the record of every
   * refund that may have left, whatever happens to the request afterwards.
   *
   * It also removes a hang. The post-provider write used to be an array
   * transaction on the client, which is not routed to the ambient tenant
   * transaction (see tests/unit/nested-transaction-registry.test.ts): it
   * opened a second connection that waited on the row lock the claim held in
   * the first, while the first waited on it. Nothing in Postgres sees that
   * cycle, so every gateway refund inside a request stalled until the request
   * transaction timed out at 30s — rolling back the claim — and then committed
   * the status flip with the old balance. Measured on Postgres 17 before this
   * change: 30,006 ms, then P2028.
   */
  static async refund(
    request: RefundRequest,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<RefundResponse & { wholeOrderEffectsApplied: boolean }> {
    // Find payment to get provider
    // Refuse an absent transaction id BEFORE the lookup. Prisma drops
    // `undefined` filters, so `where: { transactionId: undefined }` is an EMPTY
    // where — findFirst then returns an arbitrary payment row and every step
    // below operates on the wrong order: the claim writes its status and
    // refundedAmount, the transition guard runs against its order, and a
    // successful provider call flips THAT order to refunded, restores its
    // inventory, reverses its GL and emails "Refund issued" to a customer who
    // returned nothing.
    //
    // A null transaction id is not exotic here: COD payments are created
    // without one and the mark-COD-paid route flips them to 'completed'
    // without ever setting one, and COD is the dominant method in this market.
    // The order-level refund routes already guard this; centralising it means
    // no future caller can reintroduce it.
    if (!request.transactionId) {
      throw new AppError(
        400,
        'PAYMENT_NOT_REFUNDABLE',
        'This payment has no provider transaction and cannot be refunded at the gateway. Use a manual refund method.'
      );
    }

    // transactionId is not unique (issue 769 / Ruling AMS-2): a collision
    // must never pick an arbitrary row to refund. Read two; refuse on more.
    const refundMatches = await prisma.payment.findMany({
      where: { transactionId: request.transactionId },
      include: { order: { include: { store: true } } },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    if (refundMatches.length > 1) {
      logger.error(
        { transactionId: request.transactionId, paymentIds: refundMatches.map(m => m.id) },
        '[PAYMENT] refund transaction id matches more than one payment — refusing to guess'
      );
      throw new AppError(
        409,
        'AMBIGUOUS_PAYMENT',
        'This transaction id matches more than one payment. Refund it from the provider dashboard and contact support.'
      );
    }
    const payment = refundMatches[0];

    if (!payment) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }

    // `amount: 0` is a CALLER BUG, never "refund the whole payment".
    // `Return.refundAmount` is `Int @default(0)` and NOT NULL, so
    // `returnRequest.refundAmount ?? undefined` yields 0 — and the old
    // `!request.amount` predicate turned every partial return whose amount was
    // never entered into a FULL provider refund plus a whole-order
    // `order/refunded`, reversing the entire sale journal and erasing the
    // revenue, tax and COGS for the items the customer kept. Only an ABSENT
    // amount may mean "the whole payment"; a zero or negative one is rejected
    // loudly before any money moves.
    if (request.amount != null && request.amount <= 0) {
      throw new AppError(
        400,
        'INVALID_REFUND_AMOUNT',
        'Refund amount must be greater than zero. Omit it to refund the full payment.'
      );
    }

    // Budget against what is LEFT on the payment, not its original amount: a
    // prior partial refund already sent part of it back, and `refundedAmount`
    // records how much. Measuring "full" against `payment.amount` would let a
    // second refund exceed the balance, and would read the remainder of an
    // already-partially-refunded payment as a partial refund (skipping the
    // whole-order fanout that a genuinely exhausting refund owes).
    const alreadyRefunded = payment.refundedAmount ?? 0;
    const refundableRemaining = payment.amount - alreadyRefunded;
    if (refundableRemaining <= 0) {
      throw new AppError(
        400,
        'ALREADY_REFUNDED',
        'This payment has already been refunded in full.'
      );
    }
    if (request.amount != null && request.amount > refundableRemaining) {
      throw new AppError(
        400,
        'REFUND_EXCEEDS_REMAINING',
        'Refund amount exceeds the un-refunded balance of this payment.'
      );
    }
    const amountToRefund = request.amount ?? refundableRemaining;
    // Does this refund use up the payment? That decides the PAYMENT's status.
    const isFullRefund = amountToRefund >= refundableRemaining;
    // Does it reverse the ORDER? Not the same question (#1402). Payment
    // exhaustion only means the money is gone; `refund-via-provider` and the
    // settle webhook raise `refundedAmount` without any Return row, so a
    // partial return's allocation can equal what is left while lines the
    // customer kept are still on the order. A caller that applies item-level
    // effects itself says so, and then the order stays as it is.
    const flipsOrder = isFullRefund && !request.itemLevel;

    // Reject a stale/invalid order state BEFORE any money moves. A full
    // refund flips `Order.status` to 'refunded' below (bypassing
    // `updateStatus`) — guard it with the same state machine so a refund
    // request against an order some OTHER path already moved to a terminal
    // state (e.g. `cancelled`) can't silently regress it. Deliberately
    // checked here, before the payment claim and the provider call, not at
    // the DB-write site further down — an invalid transition must never
    // reach the gateway (money-integrity: no undo API for a real refund).
    if (flipsOrder && payment.order) {
      assertValidTransition(payment.order.status, 'refunded');
    }

    // The payment's own store, not the caller's: RLS for the separately
    // committed writes below must scope to the row being written.
    const moneyStoreId = payment.order?.storeId ?? storeId;
    const claimId = crypto.randomUUID();
    const refundEvent = (
      eventType: string,
      reason: string,
      extra: Record<string, unknown> = {}
    ): Prisma.PaymentEventUncheckedCreateInput => ({
      paymentId: payment.id,
      storeId: moneyStoreId ?? '',
      orderId: payment.orderId,
      eventType,
      provider: payment.provider,
      details: {
        reason,
        claimId,
        amount: amountToRefund,
        refundKey: request.refundKey ?? null,
        ...extra,
      } as Prisma.InputJsonValue,
    });

    // Atomically CLAIM the payment before touching the provider. A plain
    // `status === 'completed'` read-check is a TOCTOU race: two concurrent
    // refund requests (admin double-click, client retry, two staff on one
    // order) both read 'completed', both pass, and both call provider.refund()
    // — a double refund at the gateway with no undo API = real money lost.
    // We flip the refundable status -> the terminal refund status in one atomic
    // updateMany; only the request whose update matches (count === 1) proceeds.
    // (PaymentStatus is a Prisma enum with no transient 'refunding' value, so
    // we claim with the final status and revert to the pre-claim one if the
    // provider call throws — avoids an enum migration.)
    //
    // 'partially_refunded' is a legitimate STARTING state — a payment can be
    // refunded piece by piece (two partial returns on one order), so the claim
    // must accept it. But 'partially_refunded' -> 'partially_refunded' is not a
    // state CHANGE, so the status flip alone stops being a mutex there. The
    // guard is therefore a compare-and-swap on `refundedAmount`: we match the
    // balance we read and write the post-refund one in the same statement, so
    // of two concurrent requests only the one that still sees the old balance
    // matches. (This is also why the increment moved out of the post-provider
    // transaction below — it IS the claim now.)
    //
    // The claim is recorded as a `refund_initiated` payment event in the SAME
    // committed transaction (#1317). A process that dies between this commit
    // and the provider's answer leaves a balance raised by money that may
    // never have moved; the event is what lets the stuck-claim sweep find it
    // and an operator see it on the order page, instead of a column value
    // indistinguishable from a real refund.
    const claimedStatus = isFullRefund ? 'refunded' : 'partially_refunded';
    await commitOnOwnTransaction(moneyStoreId, async () => {
      const claim = await prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: ['completed', 'partially_refunded'] },
          refundedAmount: alreadyRefunded,
        },
        data: { status: claimedStatus, refundedAmount: alreadyRefunded + amountToRefund },
      });
      if (claim.count === 0) {
        throw new AppError(
          400,
          'INVALID_STATE',
          'Payment is not refundable or a refund is already in progress'
        );
      }
      // One refund per business event. The caller's own mutex (the Return's
      // completion claim) lives in the request transaction, so it is released
      // by the very rollback that follows a failure AFTER the money left —
      // leaving the return retryable while the refund stands. This check is
      // committed state, so the retry is refused here instead of paying again.
      // Evaluated after the CAS so the payment row lock serialises two claims
      // for the same key.
      if (request.refundKey) {
        const outstanding = await findOutstandingRefundClaims(payment.id, request.refundKey);
        if (outstanding.length > 0) {
          throw new AppError(
            409,
            'REFUND_ALREADY_ISSUED',
            'A refund for this was already sent to the payment provider and may have gone through. Check the provider dashboard before refunding again.',
            { refundKey: request.refundKey }
          );
        }
      }
      await prisma.paymentEvent.create({
        data: {
          ...refundEvent(REFUND_CLAIM_EVENT, 'refund_claimed'),
          fromStatus: payment.status,
          toStatus: claimedStatus,
        },
      });
    });

    // Undo the claim — ONLY for a failure that proves nothing was sent. A
    // decrement rather than a compare-and-swap back to the old balance: the
    // claim is committed now, so another refund on the same payment may have
    // raised the balance past ours in the meantime, and a CAS on our old value
    // would silently fail to release anything.
    const releaseClaim = async (reason: string, err: unknown) => {
      try {
        await commitOnOwnTransaction(moneyStoreId, async () => {
          const released = await prisma.payment.updateMany({
            where: { id: payment.id, refundedAmount: { gte: amountToRefund } },
            data: { refundedAmount: { decrement: amountToRefund } },
          });
          if (released.count !== 1) {
            throw new Error('refund claim no longer on the payment row');
          }
          const row = await prisma.payment.findUnique({
            where: { id: payment.id },
            select: { amount: true, refundedAmount: true },
          });
          const left = row?.refundedAmount ?? 0;
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status:
                left <= 0
                  ? payment.status
                  : left >= (row?.amount ?? payment.amount)
                    ? 'refunded'
                    : 'partially_refunded',
            },
          });
          await prisma.paymentEvent.create({
            data: {
              ...refundEvent(REFUND_RELEASED_EVENT, reason, {
                error: err instanceof Error ? err.message : String(err),
              }),
              fromStatus: claimedStatus,
            },
          });
        });
      } catch (releaseError) {
        // The claim stays on the row and stays OUTSTANDING in the event log,
        // so the stuck-claim sweep reports it rather than it vanishing.
        logger.error(
          { err: releaseError, paymentId: payment.id, claimId },
          '[PAYMENT] failed to release refund claim after a refund that was not sent — balance overstated, manual reconciliation required'
        );
      }
    };

    const providerName = provider || (payment.provider as PaymentProvider);
    const effectiveStoreId = storeId || payment.order?.storeId;
    // Resolving the provider is not a provider call: a failure here sent nothing.
    let providerImpl: IPaymentProvider;
    try {
      providerImpl = await factory.getProvider(providerName, effectiveStoreId);
    } catch (resolveError) {
      await releaseClaim('provider_unavailable', resolveError);
      throw resolveError;
    }

    let response: RefundResponse;
    try {
      // An ABSENT amount means "the whole payment" to every provider, so it
      // would send the ORIGINAL amount back — paying the already-refunded
      // portion a second time. Once anything has been refunded, spell the
      // remaining balance out. Only the provider's own fields are passed on.
      response = await providerImpl.refund({
        transactionId: request.transactionId,
        reason: request.reason,
        amount:
          request.amount == null && alreadyRefunded > 0 ? refundableRemaining : request.amount,
      });
    } catch (providerError) {
      if (providerError instanceof ProviderRejectedError) {
        // The provider answered and refused, or the request was never sent:
        // no money moved. Release the claim so the admin can legitimately retry.
        await releaseClaim('provider_rejected', providerError);
        throw providerError;
      }
      // A timeout, a dropped connection, a 5xx: the refund may have executed
      // (#1359). Releasing here is how a timeout became a second real refund —
      // the balance was reset, the caller's "did the balance move?" probe read
      // no, and the merchant was told to retry. Keep the claim: the balance
      // then errs toward "refunded", which blocks a second refund instead of
      // funding one, and the event marks it for reconciliation.
      await commitOnOwnTransaction(moneyStoreId, async () => {
        await prisma.paymentEvent.create({
          data: refundEvent(REFUND_INDETERMINATE_EVENT, 'provider_no_clear_answer', {
            error: providerError instanceof Error ? providerError.message : String(providerError),
          }),
        });
      }).catch(eventError =>
        logger.error(
          { err: eventError, paymentId: payment.id, claimId },
          '[PAYMENT] failed to record an indeterminate refund — the claim stands, reconcile manually'
        )
      );
      logger.error(
        { err: providerError, paymentId: payment.id, claimId, amount: amountToRefund },
        '[PAYMENT] provider gave no clear answer to a refund — claim KEPT, outcome unknown, reconcile with the provider'
      );
      throw markRefundMayHaveExecuted(
        new AppError(
          502,
          'PROVIDER_REFUND_INDETERMINATE',
          'The payment provider did not confirm the refund (timeout or server error), so it may have gone through. It is recorded as pending reconciliation — check the provider dashboard before refunding again.'
        )
      );
    }

    // Record the executed refund. The claim above already applied the
    // balance and the payment status, so this adds the refund id and — for a
    // refund that reverses the order — the order flip. It does NOT rewrite the
    // status: the claim is committed, so a later claim on the same payment
    // may already have moved it on, and writing ours back would regress it.
    // Refunds are terminal at the provider (no undo API); if this write fails,
    // log loudly with the refund id so finance can reconcile, and tell the
    // caller the money moved.
    try {
      await commitOnOwnTransaction(moneyStoreId, async () => {
        const current = await prisma.payment.findUnique({
          where: { id: payment.id },
          select: { metadata: true },
        });
        const currentMetadata = current?.metadata ?? payment.metadata;
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            refundId: response.refundId,
            // NO `refundedAmount` write here — the atomic claim above already
            // applied it, and re-incrementing would double-count the balance
            // and let a later refund overshoot the payment.
            metadata: {
              ...((currentMetadata as object) || {}),
              refundId: response.refundId,
              // The atomic claim above already added this refund's amount to
              // `refundedAmount`, so record its id: the provider's async settle
              // webhook for the SAME refund must not add it a second time.
              [REFUND_EVENT_IDS_KEY]: appendRefundEventId(currentMetadata, response.refundId),
              // …and seed the per-refund status map in the same write (#1487),
              // from the same freshly re-read metadata. Left empty,
              // isRefundEventAlreadySeen falls back to the payment-wide
              // scalar, which drops the NEXT refund's webhook unread once any
              // refund settled.
              [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(
                currentMetadata,
                response.refundId,
                response.status
              ),
              refundStatus: response.status,
              refundReason: request.reason ?? null,
              refundedAt: new Date().toISOString(),
            },
          },
        });
        if (flipsOrder) {
          await prisma.order.update({
            where: { id: payment.orderId },
            data: { status: 'refunded', paymentStatus: 'refunded' },
          });
        }
        await prisma.paymentEvent.create({
          data: {
            ...refundEvent(REFUND_EXECUTED_EVENT, 'refund_sent', {
              refundId: response.refundId,
              providerStatus: response.status,
            }),
            toStatus: claimedStatus,
          },
        });
      });
      // Bust the admin aggregated-customers snapshot on a paymentStatus
      // transition — this changes the paid/refunded counts it aggregates.
      if (effectiveStoreId) await invalidateCustomersCache(effectiveStoreId);
    } catch (txError) {
      logger.error(
        {
          err: txError,
          paymentId: payment.id,
          orderId: payment.orderId,
          refundId: response.refundId,
          refundAmount: amountToRefund,
          isFullRefund,
        },
        '[PAYMENT] DB transaction failed AFTER provider refund succeeded — manual reconciliation required (refund already executed at provider, cannot undo)'
      );
      throw markRefundMayHaveExecuted(txError);
    }

    // A partial refund that no item-level flow books — the order page's
    // refund-via-provider with an amount, never a return (those always pass a
    // refundKey). Owner decision 2026-10-01 (#1209): booked as a revenue
    // refund for exactly this amount, no stock movement, keyed on the
    // provider's refund id so its later settle webhook books nothing more.
    // Sent NOW rather than after the caller's request commits: the refund
    // record above is already committed on its own transaction, so a later
    // rollback of the request must not drop the ledger entry of a refund that
    // stands. A failed send is raised for a human instead of failing the
    // caller — the money has moved either way.
    if (
      !flipsOrder &&
      !request.refundKey &&
      moneyStoreId &&
      payment.orderId &&
      !response.refundId
    ) {
      // Issue 2310: never invent a GL key the provider will not repeat. The
      // old `claim-<claimId>` fallback booked this refund under one key and
      // its settle webhook (carrying the provider's REAL id) under another,
      // so one refund booked twice. With no provider id there is nothing
      // both paths share: book nothing here, and page a human.
      const orderRef = payment.order?.orderNumber ?? payment.orderId;
      await alertUnbookedRefund({
        kind: 'partial_no_gl',
        store: { id: moneyStoreId, name: payment.order?.store?.name ?? moneyStoreId },
        orderRef,
        body: `Order ${orderRef}: a partial refund of ${amountToRefund} fils was sent to the provider outside a return, but the provider returned no refund id, so it was NOT booked here (a made-up key would double-book it when the provider's settle notice arrives). Check the provider dashboard; if no settle notice books it, book it by hand.`,
        context: { paymentId: payment.id, orderId: payment.orderId, claimId },
      });
    } else if (!flipsOrder && !request.refundKey && moneyStoreId && payment.orderId) {
      const providerRefundId = response.refundId as string;
      try {
        await OrderService.recordRefundOutsideReturn(
          moneyStoreId,
          payment.orderId,
          { providerRefundId, amount: amountToRefund },
          { sendNow: true }
        );
      } catch (sendError) {
        logger.error(
          { err: sendError, paymentId: payment.id, orderId: payment.orderId, providerRefundId },
          '[PAYMENT] partial refund outside a return: order/refunded not sent — the GL entry is missing'
        );
        const orderRef = payment.order?.orderNumber ?? payment.orderId;
        await alertUnbookedRefund({
          kind: 'partial_no_gl',
          store: { id: moneyStoreId, name: payment.order?.store?.name ?? moneyStoreId },
          orderRef,
          body: `Order ${orderRef}: a partial refund of ${amountToRefund} fils was sent to the provider outside a return, but its ledger event could not be queued — nothing books it: book it by hand.`,
          context: { paymentId: payment.id, orderId: payment.orderId, refundId: response.refundId },
        });
      }
    }

    // Refund effects: inventory restore, coupon usage decrement, affiliate
    // commission reversal. Only for full refunds — partial refunds keep
    // the inventory deducted and the commission earned, since the
    // customer kept (most of) the items. Idempotent at the OrderService
    // level so a same-order full-refund-after-partial-refund won't
    // double-up the restore.
    if (flipsOrder) {
      const order = await prisma.order.findUnique({
        where: { id: payment.orderId },
        select: { storeId: true },
      });
      if (order) {
        // Let a failure here PROPAGATE. `applyRefundEffects` is now a thin
        // dispatcher (`inngest.send('order/refunded', ...)`) — it's the
        // ONLY signal that fires inventory restore, coupon/affiliate/
        // loyalty reversal, and the customer refund email/admin push. The
        // provider money movement + Payment/Order status flip above are
        // already committed and are NOT undone by this failing — but
        // silently swallowing it here (as this used to, back when
        // applyRefundEffects did heavy inline work and this really was
        // non-fatal reconciliation debt) would drop that fanout with zero
        // signal to the caller, leaving the admin `refund-via-provider`
        // route free to report HTTP 200 for a refund whose reversal chain
        // never ran (money-integrity audit F2). The caller must see this.
        //
        // And it is recoverable (#766): the order flip committed on its own
        // above, so refund-reversal-stuck-sweep finds a `refunded` order with
        // no `refundReversedAt` and re-sends the event.
        try {
          await OrderService.applyRefundEffects(order.storeId, payment.orderId);
        } catch (effectsError) {
          throw markRefundMayHaveExecuted(effectsError);
        }
      }
    }

    return { ...response, wholeOrderEffectsApplied: flipsOrder };
  }

  /**
   * Handle webhook
   */
  static async handleWebhook(
    provider: PaymentProvider,
    payload: unknown,
    signature?: string,
    storeId?: string,
    rawBody?: string
  ): Promise<{ success: boolean; status?: string; orderId?: string }> {
    const p = await factory.getProvider(provider, storeId);

    // Owner decision 2026-10-01 (issue 2065, ruling RL-2a): a webhook is SAVED
    // first (the durable inbox row, replayable from /webhook-events) but is
    // NEVER acted on until its signature verifies. This used to be
    // `if (signature) { verify }` — fail-OPEN: a call with no signature (an
    // inbox row stored with an empty one, a replay, any future caller) skipped
    // verification and went straight on to move money. No signature is now a
    // rejection, exactly like a wrong one.
    if (!signature) {
      throw new AppError(400, 'MISSING_SIGNATURE', 'Webhook signature is required');
    }
    {
      // Verify against the raw body string when available (required for a
      // correct HMAC). Fall back to the payload object for providers that do
      // not use raw-body HMAC.
      const verifyTarget: unknown = rawBody !== undefined ? rawBody : payload;
      if (!p.verifyWebhook(verifyTarget, signature)) {
        // HMAC verification failed — could be a single misconfigured test
        // webhook (noise) or a real attacker / rotated credential (signal).
        // Throttle via redis counter: 3+ failures from the same provider
        // + store in 5 minutes = real, fire a P0 alert. Single fails just
        // throw without alerting.
        try {
          const counterKey = `payment-hmac-fail:${provider}:${storeId ?? 'platform'}`;
          const count = await redis.incrementRateLimit(counterKey, 300);
          if (count >= 3) {
            void sendAlert({
              level: 'p0',
              scope: storeId ? 'store' : 'platform',
              ...(storeId
                ? {
                    store: {
                      id: storeId,
                      name:
                        (
                          await prisma.store.findUnique({
                            where: { id: storeId },
                            select: { name: true },
                          })
                        )?.name ?? storeId,
                    },
                  }
                : {}),
              source: 'payment.webhook.hmac_fail',
              title: 'payment.webhook.hmac_fail',
              body: `${provider} webhook signature failed ${count} times in 5 min — likely a rotated webhook secret on the provider side or an attacker.`,
              context: { provider, storeId, failureCount: count },
            }).catch(() => undefined);
          }
        } catch {
          // Never let alert bookkeeping break the actual security check —
          // the throw below is the load-bearing action.
        }
        throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature');
      }
    }

    // Parse webhook using the structured payload object
    const webhookData = p.parseWebhook(payload);

    // Find and update payment. Include `order.customer` + `order.store` so we
    // can render the customer's name and store name in the post-status
    // notifications fired below — order.service.ts deferred those for online-
    // payment orders so they fire ONCE, AFTER the webhook confirms the
    // payment outcome (success or failure), not at order-creation time.
    //
    // Defense-in-depth: when storeId was resolved upfront by the route
    // handler, scope the Payment lookup to that store. Provider-generated
    // transaction IDs are globally unique in practice (separate merchant
    // accounts per provider), but adding the storeId predicate means a
    // payload that arrived with a forged/recycled transaction ID can never
    // resolve to a different merchant's order than the one that owned the
    // HMAC secret we just verified against.
    //
    // transactionId / invoiceId carry NO unique constraint (issue 769 — adding
    // one needs a production duplicate check first, see Ruling AMS-2), so a
    // bare findFirst could bind a colliding id to an arbitrary row, including
    // another tenant's when no storeId was resolved. Read up to two: more than
    // one match is refused loudly (it lands in the webhook inbox for a human)
    // instead of processing whichever row Postgres returned first.
    const paymentMatches = await prisma.payment.findMany({
      where: {
        AND: [
          {
            OR: [
              { transactionId: webhookData.transactionId },
              { invoiceId: webhookData.invoiceId },
            ],
          },
          ...(storeId ? [{ order: { storeId } }] : []),
        ],
      },
      include: {
        order: {
          include: {
            customer: true,
            store: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    if (paymentMatches.length > 1) {
      logger.error(
        {
          provider,
          storeId,
          transactionId: webhookData.transactionId,
          invoiceId: webhookData.invoiceId,
          paymentIds: paymentMatches.map(m => m.id),
        },
        '[PAYMENT WEBHOOK] provider ids match more than one payment — refusing to guess which one'
      );
      // LOUD, not just logged: this is a real provider event (the signature
      // already verified) that nothing will apply — a captured payment whose
      // order may never flip to paid. P0 per incident (the ids are in the
      // title, so a second collision is not throttled into the first). The
      // webhook processor also exempts this code from its terminal-4xx lane,
      // so it retries and dead-letters into the existing P0 path.
      const firstStoreId = paymentMatches[0]?.order?.storeId;
      await sendAlert({
        level: 'p0',
        scope: storeId ? 'store' : 'platform',
        ...(storeId
          ? {
              store: {
                id: storeId,
                name: paymentMatches[0]?.order?.store?.name ?? storeId,
              },
            }
          : {}),
        source: 'payment.webhook.ambiguous_payment',
        title: `Webhook id matches ${paymentMatches.length}+ payments — ${provider} ${webhookData.transactionId ?? webhookData.invoiceId ?? ''}`,
        body:
          `A verified ${provider} webhook names a transaction/invoice id that matches more than one payment, ` +
          `so it was NOT applied. The customer may have paid for an order that still reads unpaid. ` +
          `Find the right payment in the provider dashboard and replay the event from /webhook-events.`,
        context: {
          provider,
          storeId: storeId ?? firstStoreId ?? null,
          transactionId: webhookData.transactionId,
          invoiceId: webhookData.invoiceId ?? null,
          paymentIds: paymentMatches.map(m => m.id),
        },
      }).catch(() => undefined);
      throw new AppError(
        409,
        'AMBIGUOUS_PAYMENT',
        'Webhook transaction/invoice id matches more than one payment'
      );
    }
    const payment = paymentMatches[0] ?? null;

    if (!payment) {
      logger.error(
        { transactionId: webhookData.transactionId, storeId },
        '[PAYMENT WEBHOOK] Payment not found (or storeId mismatch — defense-in-depth scope rejected lookup)'
      );
      return { success: true, orderId: undefined }; // Acknowledge webhook even if payment not found
    }

    // Belt-and-braces: even after the scoped lookup, assert the linked
    // order's storeId matches the resolved storeId. Catches the (extremely
    // unlikely) case where storeId resolution differed from payment.order
    // by some bug in the resolver function.
    if (storeId && payment.order && payment.order.storeId !== storeId) {
      logger.error(
        {
          transactionId: webhookData.transactionId,
          resolvedStoreId: storeId,
          paymentStoreId: payment.order.storeId,
        },
        '[PAYMENT WEBHOOK] storeId mismatch between resolver and payment.order — refusing to process'
      );
      throw new AppError(400, 'STORE_MISMATCH', 'Webhook payload does not match resolved store');
    }

    // Refund webhook short-circuit. MyFatoorah delivers "RefundStatusChanged"
    // events when their finance team executes (Refunded) or rejects (Canceled)
    // a previously-submitted MakeRefund. parseWebhook tags these with the
    // `refund` field. Route them through a separate path so we don't
    // re-mutate the order's payment lifecycle every time a refund updates.
    if (webhookData.refund) {
      const prevMeta = (payment.metadata as Record<string, unknown>) || {};
      const prevRefundStatus = (prevMeta.refundStatus as string | undefined) || 'pending';
      const newStatus = webhookData.refund.status;

      // Idempotent — a REDELIVERY of this same refund at this same state is a
      // no-op. Keyed on the refund's identity: `refundStatus` is one scalar for
      // the whole payment, so after any refund settled it matched every later
      // refund's webhook and dropped it unread.
      if (
        isRefundEventAlreadySeen({
          metadata: prevMeta,
          refundId: webhookData.refund.refundId,
          status: newStatus,
          previousPaymentStatus: prevRefundStatus,
        })
      ) {
        logger.info(
          {
            paymentId: payment.id,
            orderId: payment.orderId,
            refundId: webhookData.refund.refundId,
            status: newStatus,
          },
          '[PAYMENT WEBHOOK] refund event matches stored status — no-op'
        );
        return { success: true, status: newStatus, orderId: payment.orderId };
      }

      // Out-of-band refund detection: if Payment.status was not already
      // 'refunded' / 'partially_refunded' when the executed webhook arrived,
      // the admin Refund-via-provider button never ran — someone refunded
      // directly in MyFatoorah's portal. Fire applyRefundEffects so the
      // side-effects (inventory restore, coupon decrement, loyalty reversal,
      // customer email) still happen. When the admin button DID run, we
      // skip — the side-effects fired the moment they clicked.
      //
      // WRITE ORDERING (adversarial audit P2, closes 07-15 audit F3 for
      // real): the reversal dispatch + order flip run BEFORE the durable
      // `metadata.refundStatus` write below. That metadata field is this
      // branch's idempotency key — writing it first meant a failed
      // `applyRefundEffects` (Inngest event-API blip) or a rejected
      // transition left the key committed, so the Inngest retry hit the
      // `prevRefundStatus === newStatus` no-op above, the webhook was marked
      // processed, and the reversal was silently lost forever (and because
      // the order flip never ran either, refund-reversal-stuck-sweep — which
      // keys on order status — could never rescue it). With effects-first,
      // any failure leaves NO durable state, so the retry re-enters and
      // re-runs the (idempotent) reversal dispatch.
      // Has the ORDER already been reversed? The payment's own status is the
      // wrong question, and asking it cost the whole reversal chain. A payment
      // reading `partially_refunded` counted as "handled", so once a first
      // out-of-band refund left it in that state, the refund that finally
      // SETTLED the payment was written as terminal while every effect was
      // suppressed: 5000 then 4400 of a 9400-fil payment refunded in the
      // provider's dashboard promoted the row to `refunded`, and the order sat
      // at `delivered`/`paid` with its inventory unrestored, its coupon,
      // loyalty and affiliate effects unreversed, its sale journal — revenue,
      // tax and COGS — still booked, and no refund email sent. Nothing
      // recovers it either: refund-reversal-stuck-sweep only selects orders
      // already `cancelled` or `refunded`, and the flip never ran.
      //
      // A partial refund does not reverse an order, so it must not be able to
      // stop the refund that does. The question is whether the ORDER has been
      // reversed, and the order's own status answers it.
      const orderAlreadyReversed = payment.order?.status === 'refunded';

      // How much of this payment is settled once this webhook is accounted for,
      // and whether that exhausts it. Computed ONCE, above the fanout, because
      // the whole-order side-effects and the payment status write below MUST
      // agree on it. The write records a short refund as 'partially_refunded',
      // and ReturnService explicitly accepts that status as a still-refundable
      // source. Running the whole-order fanout anyway would restore ALL
      // inventory, reverse coupon/loyalty and post the FULL GL reversal for a
      // 2000-fil refund on a 5000-fil payment while leaving 3000 refundable —
      // a later partial return would then execute a second real gateway refund
      // and restore the same units again, because the two paths guard on
      // different idempotency markers (order-level vs refundKey). Whole-order
      // effects belong to a whole-order refund; a partial refund's item-level
      // effects belong to the returns flow, which carries the line data this
      // webhook does not have. Same coupling order.routes.ts applies on the
      // manual refund-status refresh.
      //
      // Shared with the refresh-refund-status route — see resolveRefundSettlement
      // for the rule and for the two ways these copies diverged before it was
      // extracted.
      const {
        settledTotal: settledRefund,
        isFullRefund: refundIsFull,
        accountedThisEvent,
        heldUnaccountedEvent,
        heldProvenanceUnknown,
      } = resolveRefundSettlement({
        paymentAmount: payment.amount,
        alreadyRefunded: payment.refundedAmount,
        reported: [webhookData.refund.amount],
        // Distinguishes a refund nothing has counted from the provider's async
        // settle notice for one the in-band claim already applied.
        reportedEventId: webhookData.refund.refundId,
        accountedEventIds: readAccountedRefundEventIds(payment.metadata),
      });

      if (newStatus === 'completed' && !orderAlreadyReversed && refundIsFull && payment.order) {
        // Reject a stale/invalid order state before running ANY reversal
        // side-effects. A provider refund executed out-of-band for an
        // order some OTHER path already moved to the terminal `refunded`
        // state must not regress it (a cancelled order CAN be refunded, PR #770) — and must not run
        // applyRefundEffects first, which would leave the reversal applied
        // but the status write rejected.
        assertValidTransition(payment.order.status, 'refunded');

        logger.info(
          { paymentId: payment.id, orderId: payment.orderId },
          '[PAYMENT WEBHOOK] out-of-band refund detected — running applyRefundEffects fresh'
        );
        // Let a genuine failure propagate. This runs inside the retriable
        // `payment-webhook-process` Inngest step, so throwing gives 3 retries +
        // the alerts-failure-watch P0 dead-letter for a money-adjacent reversal
        // (inventory/coupon/loyalty restore + refund email). Swallowing it here
        // marked the WebhookEvent 'processed' as if the reversal succeeded.
        // Safe to retry: applyRefundEffects is idempotent (per-order
        // alreadyRestoredInventory / alreadyAppliedEffects guards).
        await OrderService.applyRefundEffects(payment.order.storeId, payment.orderId);
        // Also flip the order's paymentStatus since OrderService.updateStatus
        // is not the trigger here. PROPAGATE a failure (no .catch swallow):
        // the idempotency metadata below is not yet written, so the Inngest
        // retry re-enters this branch and re-runs the (idempotent) effects +
        // this flip, instead of losing the order flip forever.
        await prisma.order.update({
          where: { id: payment.orderId },
          data: { status: 'refunded', paymentStatus: 'refunded' },
        });
        // Bust the admin aggregated-customers snapshot — this paymentStatus
        // transition changes the paid/refunded counts it aggregates.
        await invalidateCustomersCache(payment.order.storeId);
      } else if (newStatus === 'completed' && !orderAlreadyReversed && payment.order) {
        // Partial out-of-band refund: record it on the payment below (leaving
        // the balance refundable). No order flip, no whole-order reversal —
        // see the arithmetic above. Owner decision 2026-10-01 (#1455): it is
        // booked as a revenue refund for THIS event's amount, with no stock
        // movement, keyed on the provider's refund id. Only when this event's
        // amount was actually added to the total (`accountedThisEvent`) — a
        // settle notice for a refund already counted (an in-band return or
        // order-page refund) is not a second refund. Sent BEFORE the durable
        // metadata write below, like the whole-order branch above: a failed
        // send leaves nothing written, so the webhook retry re-enters here,
        // and the GL entry is idempotent on the refund id.
        logger.info(
          {
            paymentId: payment.id,
            orderId: payment.orderId,
            refundId: webhookData.refund.refundId,
            settledFils: settledRefund,
            paymentAmountFils: payment.amount,
          },
          '[PAYMENT WEBHOOK] partial out-of-band refund — recording the balance and booking it as a revenue refund, skipping whole-order effects'
        );
        const accountedAmount = settledRefund - (payment.refundedAmount ?? 0);
        if (accountedThisEvent && accountedAmount > 0) {
          await OrderService.recordRefundOutsideReturn(payment.order.storeId, payment.orderId, {
            providerRefundId: webhookData.refund.refundId,
            amount: accountedAmount,
          });
        }
      }

      // Durable idempotency write LAST — only after the reversal side-effects
      // above have succeeded (or were legitimately skipped). Done in one
      // update so prevMeta + new fields land atomically.
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...prevMeta,
            refundId: webhookData.refund.refundId,
            // Appended only when this event's amount landed in `refundedAmount`
            // below; recording it otherwise would make a later, genuine refund
            // carrying the same id look already-counted.
            // Recorded only when this event's amount actually went into the
            // total. The settlement rule holds rather than raises when it
            // cannot establish the event is new, and an id filed against an
            // amount that was held would make the real refund carrying it look
            // already counted — so it would never be added at all.
            ...(accountedThisEvent
              ? {
                  [REFUND_EVENT_IDS_KEY]: appendRefundEventId(
                    payment.metadata,
                    webhookData.refund.refundId
                  ),
                }
              : {}),
            refundStatus: newStatus,
            // Per-refund, so the next refund's webhook is not mistaken for a
            // redelivery of this one.
            [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(
              payment.metadata,
              webhookData.refund.refundId,
              newStatus
            ),
            refundReference:
              webhookData.refund.refundReference ??
              (prevMeta.refundReference as string | undefined) ??
              null,
            refundStatusUpdatedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
          // `refundedAmount` is the CUMULATIVE refund budget that
          // PaymentService.refund compare-and-swaps against, and `status`
          // gates whether ReturnService will accept the payment at all. This
          // branch used to write both absolutely — `refundedAmount` set to
          // THIS refund's amount (the provider reports one refund, not a
          // running total) and `status` forced to 'refunded' whenever it was
          // not already. On a partially-refunded payment that erased the
          // record of every earlier refund and marked the whole payment
          // settled, so the remaining balance was recomputed against a
          // too-small total and the next partial return was rejected outright
          // for having no refundable payment.
          //
          // Cumulative and monotonic instead. An in-band refund has already
          // been accounted by the atomic claim above, so the stored value is
          // at or beyond this one and stays put; an out-of-band refund taken
          // in the provider's dashboard was never accounted, so this webhook
          // is the first evidence of it and raises the total. Terminal status
          // follows the arithmetic rather than being asserted — the SAME
          // `refundIsFull` the whole-order fanout above gates on, so the status
          // written here and the effects that ran can never disagree.
          //
          // Like the sibling refresh route (order.routes.ts, #1432), this guard
          // admits an ALREADY-partially-refunded row on purpose, so a second, genuinely
          // out-of-band partial refund can still raise the total. That is only
          // safe because resolveRefundSettlement refuses to read an unreported
          // amount — or MyFatoorah's `RefundAmount ?? Amount` invoice echo — as
          // settling a payment that already has a refund accounted. Without
          // that, the async settle webhook for an IN-BAND partial return would
          // land here and mark the payment fully refunded at its full amount,
          // stranding the remaining balance.
          ...(newStatus === 'completed' && payment.status !== 'refunded'
            ? {
                status: (refundIsFull ? 'refunded' : 'partially_refunded') as
                  | 'refunded'
                  | 'partially_refunded',
                refundedAmount: settledRefund,
              }
            : {}),
        },
      });

      // Append-only audit row — refund webhook receipt with raw payload.
      const refundToStatus =
        newStatus === 'completed' && payment.status !== 'refunded'
          ? refundIsFull
            ? ('refunded' as const)
            : ('partially_refunded' as const)
          : null;
      await recordPaymentEvent({
        paymentId: payment.id,
        storeId: payment.order?.storeId ?? '',
        orderId: payment.orderId,
        eventType: 'webhook',
        fromStatus: payment.status,
        toStatus: refundToStatus,
        provider,
        providerPayload: payload as Prisma.InputJsonValue,
        details: {
          flavour: 'refund',
          refundId: webhookData.refund.refundId,
          refundStatus: newStatus,
          refundReference: webhookData.refund.refundReference ?? null,
          ...(newStatus === 'completed' && heldUnaccountedEvent
            ? { heldUnaccountedRefund: true, reason: 'refund_amount_not_reported' }
            : newStatus === 'completed' && heldProvenanceUnknown
              ? { heldUnaccountedRefund: true, reason: 'refund_provenance_unknown' }
              : {}),
        },
      });

      // A refund reported without a usable amount changes nothing booked — it
      // needs a human — but it used to be a single info log. (The partial
      // out-of-band refund this block also used to raise is now booked above,
      // owner decision 2026-10-01.)
      if (newStatus === 'completed' && payment.order) {
        const alertStore = {
          id: payment.order.storeId,
          name: payment.order.store?.name ?? payment.order.storeId,
        };
        if (heldUnaccountedEvent) {
          // #1477: a refund nothing has counted, reported without a usable
          // amount. The balance was held, so if this is a real second refund
          // the payment still looks refundable by that much — and a later
          // return would pay it out again.
          await alertUnbookedRefund({
            kind: 'held_unaccounted',
            store: alertStore,
            orderRef: payment.order.orderNumber,
            body: `Order ${payment.order.orderNumber}: the provider reported refund ${webhookData.refund.refundId} as completed without an amount this system can use, so the refunded total was NOT raised. Check the provider dashboard: if this is a new refund, the payment's refundable balance is overstated.`,
            context: { paymentId: payment.id, refundId: webhookData.refund.refundId },
          });
        } else if (heldProvenanceUnknown) {
          // PR 2279 audit P1: the payment predates the per-refund ledger, so a
          // refund with a usable amount was HELD (not added). If it is a new
          // second refund, the refundable balance is overstated.
          await alertUnbookedRefund({
            kind: 'held_provenance_unknown',
            store: alertStore,
            orderRef: payment.order.orderNumber,
            body: `Order ${payment.order.orderNumber}: the provider reported refund ${webhookData.refund.refundId} (${webhookData.refund.amount ?? '?'} fils) as completed, but this payment predates the per-refund ledger, so the amount was NOT added to the refunded total. Check the provider dashboard: if this is a NEW refund, the payment's refundable balance is overstated and a later return could pay it out again.`,
            context: {
              paymentId: payment.id,
              refundId: webhookData.refund.refundId,
              reportedAmount: webhookData.refund.amount ?? null,
              refundedAmount: payment.refundedAmount,
            },
          });
        }
      }

      return { success: true, status: newStatus, orderId: payment.orderId };
    }

    // Paid-amount reconciliation (money-integrity audit F3, 2026-07-02).
    // A 'completed' webhook only proves the provider says the invoice is
    // paid — never on its own that the AMOUNT paid matches `order.total`.
    // `webhookData.amount` is already normalized to fils by every
    // provider's `parseWebhook` (`Math.round(providerValue * 1000)` — see
    // myfatoorah/tap/hesabe/upayments `.provider.ts`), the same unit as
    // `payment.amount` (set from `order.total` at payment creation — see
    // `PaymentService.createPayment`), so this is a direct same-unit
    // comparison, not a currency-major-vs-minor mismatch. Gate on the
    // currencies matching too, as a belt-and-braces guard against a
    // provider reporting a foreign-currency settlement value we can't
    // meaningfully compare. A short-fall beyond a 5-fils rounding
    // tolerance means: partial capture, reused/mis-configured invoice, or
    // a tampered total — none of which should ship goods. We deliberately
    // do NOT flip payment/order status in that case; we just log +
    // record + alert and acknowledge the webhook so the provider doesn't
    // retry forever.
    const isAmountUnderpaid =
      webhookData.status === 'completed' &&
      typeof webhookData.amount === 'number' &&
      Number.isFinite(webhookData.amount) &&
      webhookData.currency === payment.currency &&
      Math.abs(payment.amount - webhookData.amount) > AMOUNT_TOLERANCE_FILS &&
      webhookData.amount < payment.amount;

    if (isAmountUnderpaid) {
      logger.error(
        {
          paymentId: payment.id,
          orderId: payment.orderId,
          expectedFils: payment.amount,
          paidAmountFils: webhookData.amount,
          provider,
        },
        '[PAYMENT WEBHOOK] provider-reported paid amount is less than order total — holding order unpaid'
      );

      await recordPaymentEvent({
        paymentId: payment.id,
        storeId: payment.order?.storeId ?? '',
        orderId: payment.orderId,
        eventType: 'reconciliation',
        fromStatus: payment.status,
        toStatus: null,
        provider,
        providerPayload: payload as Prisma.InputJsonValue,
        details: {
          reason: 'paid_amount_mismatch',
          expectedFils: payment.amount,
          paidAmountFils: webhookData.amount,
          webhookEvent: webhookData.event,
        },
      });

      void sendAlert({
        level: 'p0',
        scope: 'store',
        store: {
          id: payment.order?.storeId ?? '',
          name: payment.order?.store?.name ?? payment.order?.storeId ?? 'unknown',
        },
        source: 'payment.webhook.amount_mismatch',
        title: 'payment.webhook.amount_mismatch',
        body: `Order ${payment.orderId}: ${provider} webhook reports paid ${webhookData.amount} fils but the order total is ${payment.amount} fils. Order was NOT marked as paid — investigate before fulfilling.`,
        context: {
          orderId: payment.orderId,
          paymentId: payment.id,
          provider,
          expectedFils: payment.amount,
          paidAmountFils: webhookData.amount,
        },
      }).catch(() => undefined);

      // Preserve the raw receipt on the Payment row for audit, but do NOT
      // touch `status` — leaving the order/payment exactly where they were
      // (typically pending/unpaid) rather than confirming a short payment.
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...((payment.metadata as object) || {}),
            webhookEvent: webhookData.event,
            paymentMethod: webhookData.paymentMethod,
            paidCurrency: webhookData.currency,
            paidAmount: webhookData.amount,
            amountMismatch: true,
          },
        },
      });

      return { success: true, status: webhookData.status, orderId: payment.orderId };
    }

    // Map status to our payment status
    let orderStatus: 'pending' | 'confirmed' = 'pending';
    let orderPaymentStatus: 'unpaid' | 'paid' | 'failed' | 'refunded' = 'unpaid';

    switch (webhookData.status) {
      case 'completed':
        orderStatus = 'confirmed';
        orderPaymentStatus = 'paid';
        break;
      case 'failed':
      case 'expired':
      case 'cancelled':
        orderPaymentStatus = 'failed';
        break;
      case 'refunded':
        orderPaymentStatus = 'refunded';
        break;
    }

    // Assert the ORDER transition BEFORE the payment write (adversarial audit
    // P2; mirrors payment-confirm.service.ts:222-228). The assert used to run
    // after `Payment.status` was already mutated — a stale/raced `completed`
    // webhook on a cancelled order threw at the order write but left
    // `Payment.status='completed'` + `Order.status='cancelled'` as durable
    // state on every Inngest retry: money captured for a cancelled order,
    // with no reconciler targeting that combination. Rejecting before ANY
    // write keeps the rows consistent; payment-reconcile-sweep now watches
    // for the captured-on-cancelled shape that arises when the capture
    // happened anyway at the provider.
    if (webhookData.status !== 'pending' && webhookData.status !== 'processing' && payment.order) {
      assertValidTransition(payment.order.status, orderStatus);
    }

    // Update payment
    const prevPaymentStatus = payment.status;
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: webhookData.status,
        paidAt: webhookData.paidAt,
        metadata: {
          ...((payment.metadata as object) || {}),
          webhookEvent: webhookData.event,
          paymentMethod: webhookData.paymentMethod,
          paidCurrency: webhookData.currency,
          paidAmount: webhookData.amount,
        },
      },
    });

    // Duplicate-capture watch: a second captured payment on one order means
    // the customer paid twice (replayed create → two live invoices). Alert
    // finance — best-effort, never blocks webhook processing.
    if (webhookData.status === 'completed') {
      await alertIfDuplicateCapture(payment.id, payment.orderId, provider);
    }

    // Append-only audit row — every payment webhook receipt persists the
    // raw provider payload so a dispute 6+ months later can be replayed
    // even if `payments.metadata` has since been overwritten.
    await recordPaymentEvent({
      paymentId: payment.id,
      storeId: payment.order?.storeId ?? '',
      orderId: payment.orderId,
      eventType: 'webhook',
      fromStatus: prevPaymentStatus,
      toStatus: webhookData.status,
      provider,
      providerPayload: payload as Prisma.InputJsonValue,
      details: {
        webhookEvent: webhookData.event,
        paymentMethod: webhookData.paymentMethod,
        paidCurrency: webhookData.currency,
        paidAmount: webhookData.amount,
      },
    });

    // Update order — the transition was already asserted ABOVE, before the
    // payment write, so this block can no longer be reached with an invalid
    // transition.
    if (webhookData.status !== 'pending' && webhookData.status !== 'processing') {
      await prisma.order.update({
        where: { id: payment.orderId },
        data: {
          status: orderStatus,
          paymentStatus: orderPaymentStatus,
        },
      });
      // Bust the admin aggregated-customers snapshot — this paymentStatus
      // transition changes the paid/failed/refunded counts it aggregates.
      if (payment.order?.storeId) await invalidateCustomersCache(payment.order.storeId);
    }

    // Online-payment notifications fire HERE, not at order creation. order.service.ts
    // intentionally skips its inngest.send + socket emit for non-COD orders so a
    // customer who abandons at the gateway doesn't produce a phantom "new order"
    // ping on the merchant side. We fire on the FIRST transition out of pending:
    //   - completed → "new order" fanout (emails, push, dispatcher, socket toast)
    //   - failed / expired / cancelled → "payment failed" push to admins only
    //     (customer sees the failure inline at the gateway / checkout error page)
    // Idempotency lives upstream in the webhook route (checkIdempotency), so a
    // duplicate webhook never reaches this code path twice.
    const order = payment.order;
    const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
    const customerName =
      `${order.customer?.firstName ?? shipping.firstName ?? ''} ${order.customer?.lastName ?? shipping.lastName ?? ''}`.trim() ||
      order.customer?.email ||
      shipping.email ||
      'Customer';

    if (webhookData.status === 'completed') {
      inngest
        .send({
          name: 'order/created',
          data: {
            orderId: order.id,
            storeId: order.storeId,
            paymentMethod: payment.provider,
            locale: order.locale ?? undefined,
          },
        })
        .catch((err: unknown) =>
          logger.error(
            { err, orderId: order.id },
            '[PAYMENT WEBHOOK] Failed to enqueue post-payment order/created'
          )
        );

      try {
        socketService.newOrderNotification(order.storeId, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          total: order.total,
          customerName,
        });
      } catch (notifyError) {
        logger.error(
          { err: notifyError, orderId: order.id },
          '[PAYMENT WEBHOOK] Socket emit failed'
        );
      }
    } else if (
      webhookData.status === 'failed' ||
      webhookData.status === 'expired' ||
      webhookData.status === 'cancelled'
    ) {
      OneSignalService.notifyAdminsOfPaymentFailure({
        orderId: order.id,
        orderNumber: order.orderNumber,
        storeId: order.storeId,
        storeName: order.store?.name ?? order.storeId,
        customerName,
        total: order.total,
        currency: order.currency,
        paymentMethod: payment.provider,
        reason: webhookData.status,
      }).catch(err => {
        logger.error(
          { err, orderId: order.id },
          '[PAYMENT WEBHOOK] Payment-failure notification failed'
        );
        // Pure notification (not money): don't re-throw — retrying the webhook
        // step would risk a duplicate push. But don't leave it silent either:
        // surface a throttled info-level alert so a lost failed-payment signal
        // is at least visible to an operator.
        void sendAlert({
          level: 'info',
          scope: 'platform',
          source: 'payment.webhook.failure_notify_failed',
          title: 'payment-failure admin push failed',
          body: `Could not notify store admins of a failed/expired/cancelled payment for order ${order.orderNumber}.`,
          context: { orderId: order.id, storeId: order.storeId },
        }).catch(() => undefined);
      });
    }

    return { success: true, status: webhookData.status, orderId: payment.orderId };
  }

  /**
   * Get payment by order ID
   */
  static async getPaymentByOrderId(orderId: string) {
    return prisma.payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Retry failed payment
   */
  static async retryPayment(
    paymentId: string,
    provider?: PaymentProvider
  ): Promise<PaymentResponse> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: {
          include: {
            items: { include: { product: true } },
            customer: true,
            store: true,
          },
        },
      },
    });

    if (!payment) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }

    if (payment.status !== 'failed') {
      throw new AppError(400, 'INVALID_STATE', 'Payment is not in failed state');
    }

    const order = payment.order;

    // Guest orders carry customer details on order.shippingAddress (JSON),
    // not on order.customer (which is null for guests). Same provider-side
    // validation that rejects empty CustomerEmail (MyFatoorah 400) applies on
    // retry — fall through to shippingAddress fields before defaulting.
    const retryShipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
    return this.createPayment(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        // Amount due: the order value less any customer-wallet spend (D1).
        // === order.total for every order that did not use the wallet.
        amount: order.total - (order.walletAmount ?? 0),
        currency: order.currency as Currency,
        customer: {
          id: order.customerId ?? `guest-${order.id}`,
          name:
            `${order.customer?.firstName ?? retryShipping.firstName ?? ''} ${order.customer?.lastName ?? retryShipping.lastName ?? ''}`.trim() ||
            'Customer',
          email: order.customer?.email || retryShipping.email || '',
          phone: retryShipping.phone || undefined,
        },
        items: buildPaymentLineItems(order.items),
        callbackUrl: `${config.webUrl}/checkout/success`,
        errorUrl: `${config.webUrl}/checkout/error`,
        webhookUrl: `${config.apiUrl}/api/v1/webhooks/payment/${provider || payment.provider}`,
      },
      provider || (payment.provider as PaymentProvider),
      order.storeId
    );
  }

  /**
   * Clear provider cache (call when config changes)
   */
  static clearCache(storeId?: string): void {
    factory.clearCache(storeId);
  }
}
