import Stripe from 'stripe';
import { prisma } from '@force/database';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';

// Initialize Stripe
const stripe = new Stripe(config.stripeSecretKey, {
  apiVersion: '2023-10-16',
});

export interface CreatePaymentIntentData {
  orderId: string;
  amount: number; // in cents
  currency?: string;
  customerId?: string;
  metadata?: Record<string, string>;
}

export interface RefundPaymentData {
  paymentId: string;
  amount?: number; // partial refund amount in cents
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}

export class PaymentService {
  /**
   * Create a Stripe customer for a user
   */
  static async createCustomer(userId: string, email: string, name?: string) {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { userId },
    });

    // Store Stripe customer ID in user record
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customer.id },
    });

    return customer;
  }

  /**
   * Get or create Stripe customer for a user
   */
  static async getOrCreateCustomer(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    if (user.stripeCustomerId) {
      return stripe.customers.retrieve(user.stripeCustomerId);
    }

    return this.createCustomer(
      userId,
      user.email,
      `${user.firstName} ${user.lastName}`.trim()
    );
  }

  /**
   * Create a payment intent for an order
   */
  static async createPaymentIntent(data: CreatePaymentIntentData) {
    const { orderId, amount, currency = 'usd', customerId, metadata = {} } = data;

    // Get order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    // Create payment intent
    const paymentIntentData: Stripe.PaymentIntentCreateParams = {
      amount,
      currency,
      metadata: {
        orderId,
        orderNumber: order.orderNumber,
        ...metadata,
      },
      automatic_payment_methods: {
        enabled: true,
      },
    };

    // Attach customer if available
    if (customerId) {
      paymentIntentData.customer = customerId;
    }

    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

    // Store payment record
    await prisma.payment.create({
      data: {
        orderId,
        stripePaymentIntentId: paymentIntent.id,
        amount,
        currency,
        status: 'pending',
      },
    });

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    };
  }

  /**
   * Create a checkout session for an order
   */
  static async createCheckoutSession(
    orderId: string,
    successUrl: string,
    cancelUrl: string
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: true } },
        customer: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    // Build line items
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = order.items.map(
      item => ({
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.productName,
            description: item.sku || undefined,
          },
          unit_amount: item.price,
        },
        quantity: item.quantity,
      })
    );

    // Add tax as a line item if present
    if (order.tax > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Tax',
          },
          unit_amount: order.tax,
        },
        quantity: 1,
      });
    }

    // Add shipping as a line item if present
    if (order.shipping > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Shipping',
          },
          unit_amount: order.shipping,
        },
        quantity: 1,
      });
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        orderId,
        orderNumber: order.orderNumber,
      },
      customer_email: order.customer?.email,
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Store payment record
    await prisma.payment.create({
      data: {
        orderId,
        stripeSessionId: session.id,
        amount: order.total,
        currency: 'usd',
        status: 'pending',
      },
    });

    return {
      sessionId: session.id,
      url: session.url,
    };
  }

  /**
   * Process a refund
   */
  static async refundPayment(data: RefundPaymentData) {
    const { paymentId, amount, reason } = data;

    // Get payment record
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });

    if (!payment) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }

    if (payment.status !== 'completed') {
      throw new AppError(400, 'INVALID_STATE', 'Payment is not completed');
    }

    // Get the charge from Stripe
    let chargeId: string | undefined;

    if (payment.stripePaymentIntentId) {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        payment.stripePaymentIntentId
      );
      chargeId = paymentIntent.latest_charge as string;
    } else if (payment.stripeSessionId) {
      const session = await stripe.checkout.sessions.retrieve(
        payment.stripeSessionId
      );
      if (session.payment_intent) {
        const paymentIntent = await stripe.paymentIntents.retrieve(
          session.payment_intent as string
        );
        chargeId = paymentIntent.latest_charge as string;
      }
    }

    if (!chargeId) {
      throw new AppError(400, 'INVALID_STATE', 'No charge found for this payment');
    }

    // Create refund
    const refundParams: Stripe.RefundCreateParams = {
      charge: chargeId,
      reason: reason || 'requested_by_customer',
    };

    if (amount) {
      refundParams.amount = amount;
    }

    const refund = await stripe.refunds.create(refundParams);

    // Update payment record
    const refundedAmount = amount || payment.amount;
    const isFullRefund = refundedAmount >= payment.amount;

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: isFullRefund ? 'refunded' : 'partially_refunded',
        refundedAmount: { increment: refundedAmount },
        stripeRefundId: refund.id,
      },
    });

    // Update order status if full refund
    if (isFullRefund && payment.order) {
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'refunded' },
      });
    }

    return refund;
  }

  /**
   * Handle Stripe webhook events
   */
  static async handleWebhook(payload: Buffer, signature: string) {
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        payload,
        signature,
        config.stripeWebhookSecret
      );
    } catch {
      throw new AppError(400, 'WEBHOOK_ERROR', 'Invalid webhook signature');
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentIntentSucceeded(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentIntentFailed(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      case 'checkout.session.completed':
        await this.handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session
        );
        break;

      case 'charge.refunded':
        await this.handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      case 'charge.dispute.created':
        await this.handleDisputeCreated(event.data.object as Stripe.Dispute);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return { received: true };
  }

  /**
   * Handle successful payment intent
   */
  private static async handlePaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent
  ) {
    const payment = await prisma.payment.findFirst({
      where: { stripePaymentIntentId: paymentIntent.id },
    });

    if (payment) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'completed',
          paidAt: new Date(),
        },
      });

      // Update order status
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'confirmed', paymentStatus: 'paid' },
      });
    }
  }

  /**
   * Handle failed payment intent
   */
  private static async handlePaymentIntentFailed(
    paymentIntent: Stripe.PaymentIntent
  ) {
    const payment = await prisma.payment.findFirst({
      where: { stripePaymentIntentId: paymentIntent.id },
    });

    if (payment) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          failureReason: paymentIntent.last_payment_error?.message || 'Payment failed',
        },
      });

      // Update order payment status
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: 'failed' },
      });
    }
  }

  /**
   * Handle completed checkout session
   */
  private static async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session
  ) {
    const payment = await prisma.payment.findFirst({
      where: { stripeSessionId: session.id },
    });

    if (payment) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'completed',
          stripePaymentIntentId: session.payment_intent as string,
          paidAt: new Date(),
        },
      });

      // Update order status
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'confirmed', paymentStatus: 'paid' },
      });
    }
  }

  /**
   * Handle charge refunded
   */
  private static async handleChargeRefunded(charge: Stripe.Charge) {
    if (!charge.payment_intent) return;

    const payment = await prisma.payment.findFirst({
      where: { stripePaymentIntentId: charge.payment_intent as string },
    });

    if (payment) {
      const isFullRefund = charge.amount_refunded >= charge.amount;

      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: isFullRefund ? 'refunded' : 'partially_refunded',
          refundedAmount: charge.amount_refunded,
        },
      });

      if (isFullRefund) {
        await prisma.order.update({
          where: { id: payment.orderId },
          data: { status: 'refunded', paymentStatus: 'refunded' },
        });
      }
    }
  }

  /**
   * Handle dispute created
   */
  private static async handleDisputeCreated(dispute: Stripe.Dispute) {
    // Log dispute for manual review
    console.error('DISPUTE CREATED:', {
      disputeId: dispute.id,
      chargeId: dispute.charge,
      amount: dispute.amount,
      reason: dispute.reason,
    });

    // Find and update the payment
    if (dispute.payment_intent) {
      const payment = await prisma.payment.findFirst({
        where: { stripePaymentIntentId: dispute.payment_intent as string },
      });

      if (payment) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'disputed' },
        });

        await prisma.order.update({
          where: { id: payment.orderId },
          data: { paymentStatus: 'disputed' },
        });
      }
    }
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
  static async retryPayment(paymentId: string) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });

    if (!payment) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }

    if (payment.status !== 'failed') {
      throw new AppError(400, 'INVALID_STATE', 'Payment is not in failed state');
    }

    // Create new payment intent
    return this.createPaymentIntent({
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
    });
  }
}
