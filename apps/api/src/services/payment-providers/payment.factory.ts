import { prisma } from '@force/database';
import { config } from '../../config';
import { AppError } from '../../middleware/error-handler';
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
// Unified interface for all Kuwait payment providers
// ==========================================

class PaymentFactory {
  private providers: Map<PaymentProvider, IPaymentProvider> = new Map();
  private defaultProvider: PaymentProvider = 'tap';

  constructor() {
    this.initializeProviders();
  }

  private initializeProviders(): void {
    // Initialize Tap Payments
    if (config.tapApiKey) {
      const tap = new TapPaymentProvider();
      tap.initialize({
        apiKey: config.tapApiKey,
        secretKey: config.tapSecretKey,
        baseUrl: '',
        isTestMode: config.paymentTestMode,
        webhookSecret: config.tapWebhookSecret,
      });
      this.providers.set('tap', tap);
    }

    // Initialize MyFatoorah
    if (config.myfatoorahApiKey) {
      const myfatoorah = new MyFatoorahPaymentProvider();
      myfatoorah.initialize({
        apiKey: config.myfatoorahApiKey,
        baseUrl: '',
        isTestMode: config.paymentTestMode,
      });
      this.providers.set('myfatoorah', myfatoorah);
    }

    // Initialize Hesabe
    if (config.hesabeApiKey) {
      const hesabe = new HesabePaymentProvider();
      hesabe.initialize({
        apiKey: config.hesabeApiKey,
        secretKey: config.hesabeSecretKey,
        merchantId: config.hesabeMerchantId,
        baseUrl: '',
        isTestMode: config.paymentTestMode,
        webhookSecret: config.hesabeWebhookSecret,
      });
      this.providers.set('hesabe', hesabe);
    }

    // Initialize UPayments
    if (config.upaymentsApiKey) {
      const upayments = new UPaymentsProvider();
      upayments.initialize({
        apiKey: config.upaymentsApiKey,
        secretKey: config.upaymentsSecretKey,
        merchantId: config.upaymentsMerchantId,
        baseUrl: '',
        isTestMode: config.paymentTestMode,
        webhookSecret: config.upaymentsWebhookSecret,
      });
      this.providers.set('upayments', upayments);
    }

    // Set default provider
    if (config.defaultPaymentProvider) {
      this.defaultProvider = config.defaultPaymentProvider as PaymentProvider;
    } else if (this.providers.size > 0) {
      const firstProvider = this.providers.keys().next().value;
      if (firstProvider) {
        this.defaultProvider = firstProvider;
      }
    }

    console.log(`[PAYMENT] Initialized providers: ${Array.from(this.providers.keys()).join(', ')}`);
    console.log(`[PAYMENT] Default provider: ${this.defaultProvider}`);
  }

  getProvider(provider?: PaymentProvider): IPaymentProvider {
    const providerName = provider || this.defaultProvider;
    const p = this.providers.get(providerName);

    if (!p) {
      throw new AppError(
        500,
        'PAYMENT_PROVIDER_NOT_CONFIGURED',
        `Payment provider '${providerName}' is not configured`
      );
    }

    return p;
  }

  getAvailableProviders(): PaymentProvider[] {
    return Array.from(this.providers.keys());
  }

  isProviderAvailable(provider: PaymentProvider): boolean {
    return this.providers.has(provider);
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
  static getAvailableProviders(): PaymentProvider[] {
    return factory.getAvailableProviders();
  }

  /**
   * Get payment methods for a specific provider
   */
  static async getPaymentMethods(
    amount: number,
    currency: Currency = 'KWD',
    provider?: PaymentProvider
  ): Promise<{ provider: PaymentProvider; methods: AvailablePaymentMethod[] }[]> {
    const providers = provider ? [provider] : factory.getAvailableProviders();
    const results: { provider: PaymentProvider; methods: AvailablePaymentMethod[] }[] = [];

    for (const p of providers) {
      try {
        const methods = await factory.getProvider(p).getPaymentMethods(amount, currency);
        results.push({ provider: p, methods });
      } catch (error) {
        console.error(`[PAYMENT] Failed to get methods from ${p}:`, error);
      }
    }

    return results;
  }

  /**
   * Create a payment
   */
  static async createPayment(
    request: CreatePaymentRequest,
    provider?: PaymentProvider
  ): Promise<PaymentResponse> {
    const p = factory.getProvider(provider);
    const response = await p.createPayment(request);

    // Store payment record in database
    await prisma.payment.create({
      data: {
        orderId: request.orderId,
        method: p.name,
        amount: request.amount,
        currency: request.currency,
        status: 'pending',
        transactionId: response.transactionId,
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
    provider?: PaymentProvider
  ): Promise<PaymentStatusResponse> {
    // Try to find the payment in database to get the provider
    const payment = await prisma.payment.findFirst({
      where: { transactionId },
    });

    const providerName = provider || (payment?.method as PaymentProvider) || 'tap';
    return factory.getProvider(providerName).getPaymentStatus(transactionId);
  }

  /**
   * Process refund
   */
  static async refund(request: RefundRequest, provider?: PaymentProvider): Promise<RefundResponse> {
    // Find payment to get provider
    const payment = await prisma.payment.findFirst({
      where: { transactionId: request.transactionId },
      include: { order: true },
    });

    if (!payment) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }

    if (payment.status !== 'completed') {
      throw new AppError(400, 'INVALID_STATE', 'Payment is not completed');
    }

    const providerName = provider || (payment.method as PaymentProvider);
    const response = await factory.getProvider(providerName).refund(request);

    // Update payment record
    const isFullRefund = !request.amount || request.amount >= payment.amount;

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: isFullRefund ? 'refunded' : 'partially_refunded',
        refundedAmount: { increment: request.amount || payment.amount },
        metadata: {
          ...(payment.metadata as object || {}),
          refundId: response.refundId,
          refundStatus: response.status,
        },
      },
    });

    // Update order if full refund
    if (isFullRefund) {
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'refunded', paymentStatus: 'refunded' },
      });
    }

    return response;
  }

  /**
   * Handle webhook
   */
  static async handleWebhook(
    provider: PaymentProvider,
    payload: unknown,
    signature?: string
  ): Promise<{ success: boolean; status?: string }> {
    const p = factory.getProvider(provider);

    // Verify signature if provided
    if (signature && !p.verifyWebhook(payload, signature)) {
      throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature');
    }

    // Parse webhook
    const webhookData = p.parseWebhook(payload);

    // Find and update payment
    const payment = await prisma.payment.findFirst({
      where: {
        OR: [
          { transactionId: webhookData.transactionId },
          { transactionId: webhookData.invoiceId },
        ],
      },
      include: { order: true },
    });

    if (!payment) {
      console.error('[PAYMENT WEBHOOK] Payment not found:', webhookData.transactionId);
      return { success: true }; // Acknowledge webhook even if payment not found
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
          ...(payment.metadata as object || {}),
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

    return { success: true, status: webhookData.status };
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

    return this.createPayment(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: order.total,
        currency: order.currency as Currency,
        customer: {
          id: order.customerId,
          name: `${order.customer.firstName} ${order.customer.lastName}`,
          email: order.customer.email,
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
      provider || (payment.method as PaymentProvider)
    );
  }
}
