import { Router, Request, Response, NextFunction } from 'express';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider } from '../services/payment-providers/types';
import { config } from '../config';

const router = Router();

// ==========================================
// Kuwait Payment Provider Webhooks
// Supports: Tap, MyFatoorah, Hesabe, UPayments
// ==========================================

/**
 * POST /webhooks/payment/:provider
 * Handle payment provider webhooks
 */
router.post(
  '/payment/:provider',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = req.params.provider as PaymentProvider;
      const signature = req.headers['x-signature'] as string
        || req.headers['x-tap-signature'] as string
        || req.headers['x-myfatoorah-signature'] as string
        || req.headers['x-hesabe-signature'] as string
        || req.headers['x-upayments-signature'] as string
        || '';

      // Validate provider
      const validProviders: PaymentProvider[] = ['tap', 'myfatoorah', 'hesabe', 'upayments'];
      if (!validProviders.includes(provider)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PROVIDER', message: 'Invalid payment provider' },
        });
        return;
      }

      // Handle webhook
      const result = await PaymentService.handleWebhook(provider, req.body, signature);

      console.log(`[WEBHOOK] ${provider}: ${JSON.stringify(result)}`);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[WEBHOOK ERROR]', error);
      next(error);
    }
  }
);

/**
 * POST /webhooks/payment
 * Generic payment webhook (auto-detect provider)
 */
router.post('/payment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Try to detect provider from payload
    let provider: PaymentProvider = 'tap';

    if (req.body.InvoiceId !== undefined) {
      provider = 'myfatoorah';
    } else if (req.body.paymentId && req.body.resultCode) {
      provider = 'hesabe';
    } else if (req.body.invoice_id) {
      provider = 'upayments';
    } else if (req.body.id && req.body.object === 'charge') {
      provider = 'tap';
    }

    const signature = req.headers['x-signature'] as string || '';
    const result = await PaymentService.handleWebhook(provider, req.body, signature);

    console.log(`[WEBHOOK] Auto-detected ${provider}: ${JSON.stringify(result)}`);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
    next(error);
  }
});

/**
 * GET /webhooks/payment/callback
 * Payment callback handler (redirect after payment)
 */
router.get('/payment/callback', async (req: Request, res: Response) => {
  const { tap_id, paymentId, Id, invoice_id } = req.query;
  const transactionId = (tap_id || paymentId || Id || invoice_id) as string;

  if (!transactionId) {
    res.redirect(`${config.webUrl}/checkout/error?reason=missing_transaction`);
    return;
  }

  try {
    // Get payment status
    const status = await PaymentService.getPaymentStatus(transactionId);

    if (status.status === 'completed') {
      res.redirect(`${config.webUrl}/checkout/success?transaction=${transactionId}`);
    } else if (status.status === 'failed' || status.status === 'cancelled') {
      res.redirect(`${config.webUrl}/checkout/error?reason=${status.failureReason || status.status}`);
    } else {
      res.redirect(`${config.webUrl}/checkout/pending?transaction=${transactionId}`);
    }
  } catch (error) {
    console.error('[CALLBACK ERROR]', error);
    res.redirect(`${config.webUrl}/checkout/error?reason=unknown`);
  }
});

/**
 * GET /webhooks/payment/error
 * Payment error callback handler
 */
router.get('/payment/error', async (req: Request, res: Response) => {
  const { error, message, transaction_id } = req.query;

  console.error('[PAYMENT ERROR CALLBACK]', { error, message, transaction_id });

  res.redirect(
    `${config.webUrl}/checkout/error?reason=${encodeURIComponent(String(message || error || 'payment_failed'))}`
  );
});

export default router;
