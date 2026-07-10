import type { KnownFailureCase } from '../types';

/** Store FAQ answer names the payment-gateway backend company (MyFatoorah) instead of the customer-facing method names — the bulk-ai-faq-aeo prompt explicitly forbids this ("customers tap KNET/Visa/Mastercard/Apple Pay buttons, they don't know which back-end gateway processes them"). */
export const storeFaqNamesGatewayCompany: KnownFailureCase = {
  id: 'store-faq-names-gateway-company',
  type: 'store-faq',
  description:
    'FAQ answer names "MyFatoorah" instead of the payment methods customers actually see (KNET/Visa/Mastercard).',
  input: { storeDescription: 'Kuwait-based online store.' },
  output: [
    {
      question: 'What payment methods do you accept?',
      questionAr: 'ما هي طرق الدفع المتاحة؟',
      answer: 'We process payments securely through MyFatoorah.',
      answerAr: 'نعالج المدفوعات بأمان عبر مايفاتورة.',
    },
  ],
  expectedFailedChecks: ['no-payment-gateway-company-names'],
};
