// Re-export the Egypt payment service from the payment factory
// Stripe doesn't work in Egypt - we use local payment providers instead

export { PaymentService } from './payment-providers/payment.factory';
export * from './payment-providers/types';
