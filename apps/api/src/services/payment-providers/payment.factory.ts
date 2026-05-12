import { prisma } from '@force/database';
import { config } from '../../config';
import { AppError } from '../../middleware/error-handler';
import logger from '../../lib/logger';
import { encryption } from '../encryption.service';
import { OrderService } from '../order.service';
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

// ==========================================
// Payment Factory
// Database-driven configuration for Kuwait payment providers
// Supports both global and per-store configurations
// ==========================================

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
    await prisma.payment.create({
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
   * Process refund
   */
  static async refund(
    request: RefundRequest,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<RefundResponse> {
    // Find payment to get provider
    const payment = await prisma.payment.findFirst({
      where: { transactionId: request.transactionId },
      include: { order: { include: { store: true } } },
    });

    if (!payment) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }

    if (payment.status !== 'completed') {
      throw new AppError(400, 'INVALID_STATE', 'Payment is not completed');
    }

    const providerName = provider || (payment.provider as PaymentProvider);
    const effectiveStoreId = storeId || payment.order?.storeId;
    const response = await (
      await factory.getProvider(providerName, effectiveStoreId)
    ).refund(request);

    // Update payment record
    const isFullRefund = !request.amount || request.amount >= payment.amount;

    // Wrap the two db writes in a transaction so payment + order rows can't
    // disagree after a partial failure (e.g. payment marked 'refunded' but
    // the order still shows status 'paid'). External provider refund stays
    // OUTSIDE the transaction — refunds are terminal at the provider level
    // (no undo API), and money is already back to the customer. If the
    // transaction below fails, log loudly with the refund transaction id
    // so finance can manually reconcile the rows; we cannot reverse the
    // refund itself.
    try {
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: isFullRefund ? 'refunded' : 'partially_refunded',
            refundId: response.refundId,
            refundedAmount: { increment: request.amount || payment.amount },
            metadata: {
              ...((payment.metadata as object) || {}),
              refundId: response.refundId,
              refundStatus: response.status,
            },
          },
        }),
        ...(isFullRefund
          ? [
              prisma.order.update({
                where: { id: payment.orderId },
                data: { status: 'refunded', paymentStatus: 'refunded' },
              }),
            ]
          : []),
      ]);
    } catch (txError) {
      logger.error(
        {
          err: txError,
          paymentId: payment.id,
          orderId: payment.orderId,
          refundId: response.refundId,
          refundAmount: request.amount || payment.amount,
          isFullRefund,
        },
        '[PAYMENT] DB transaction failed AFTER provider refund succeeded — manual reconciliation required (refund already executed at provider, cannot undo)'
      );
      throw txError;
    }

    // Refund effects: inventory restore, coupon usage decrement, affiliate
    // commission reversal. Only for full refunds — partial refunds keep
    // the inventory deducted and the commission earned, since the
    // customer kept (most of) the items. Idempotent at the OrderService
    // level so a same-order full-refund-after-partial-refund won't
    // double-up the restore.
    if (isFullRefund) {
      const order = await prisma.order.findUnique({
        where: { id: payment.orderId },
        select: { storeId: true },
      });
      if (order) {
        try {
          await OrderService.applyRefundEffects(order.storeId, payment.orderId);
        } catch (effectsError) {
          // Non-fatal: provider refund already succeeded and the order
          // is marked refunded. Log loud so finance can reconcile any
          // inventory / commission drift manually.
          logger.error(
            {
              err: effectsError,
              orderId: payment.orderId,
              refundId: response.refundId,
            },
            '[PAYMENT] applyRefundEffects failed after refund — inventory/coupon/commission may be inconsistent'
          );
        }
      }
    }

    return response;
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

    // Verify signature against the raw body string when available (required for
    // correct HMAC calculation). Fall back to the payload object for providers
    // that do not use raw-body HMAC.
    if (signature) {
      const verifyTarget: unknown = rawBody !== undefined ? rawBody : payload;
      if (!p.verifyWebhook(verifyTarget, signature)) {
        throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature');
      }
    }

    // Parse webhook using the structured payload object
    const webhookData = p.parseWebhook(payload);

    // Find and update payment
    const payment = await prisma.payment.findFirst({
      where: {
        OR: [{ transactionId: webhookData.transactionId }, { invoiceId: webhookData.invoiceId }],
      },
      include: { order: true },
    });

    if (!payment) {
      logger.error(
        { transactionId: webhookData.transactionId },
        '[PAYMENT WEBHOOK] Payment not found'
      );
      return { success: true, orderId: undefined }; // Acknowledge webhook even if payment not found
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

    // Update payment
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

    // Update order
    if (webhookData.status !== 'pending' && webhookData.status !== 'processing') {
      await prisma.order.update({
        where: { id: payment.orderId },
        data: {
          status: orderStatus,
          paymentStatus: orderPaymentStatus,
        },
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
        amount: order.total,
        currency: order.currency as Currency,
        customer: {
          id: order.customerId ?? `guest-${order.id}`,
          name:
            `${order.customer?.firstName ?? retryShipping.firstName ?? ''} ${order.customer?.lastName ?? retryShipping.lastName ?? ''}`.trim() ||
            'Customer',
          email: order.customer?.email || retryShipping.email || '',
          phone: retryShipping.phone || undefined,
        },
        items: order.items.map(item => ({
          name: item.productName,
          quantity: item.quantity,
          unitPrice: item.price,
          sku: item.sku || undefined,
        })),
        callbackUrl: `${config.webUrl}/checkout/success`,
        errorUrl: `${config.webUrl}/checkout/error`,
        webhookUrl: `${config.apiUrl}/webhooks/payment`,
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
