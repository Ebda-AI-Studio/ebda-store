import type { KnownFailureCase } from '../types';

/** Store FAQ answer names the payment-gateway backend company (Paymob) instead of the customer-facing method names — the bulk-ai-faq-aeo prompt explicitly forbids this ("customers pick Visa / Meeza / a wallet, they don't know which back-end gateway processes them"). */
export const storeFaqNamesGatewayCompany: KnownFailureCase = {
  id: 'store-faq-names-gateway-company',
  type: 'store-faq',
  description:
    'FAQ answer names "Paymob" instead of the payment methods customers actually see (Visa/Meeza/wallets).',
  input: { storeDescription: 'Egypt-based online store.' },
  output: [
    {
      question: 'What payment methods do you accept?',
      questionAr: 'ما هي طرق الدفع المتاحة؟',
      answer: 'We process payments securely through Paymob.',
      answerAr: 'نعالج المدفوعات بأمان عبر باي موب.',
    },
  ],
  expectedFailedChecks: ['no-payment-gateway-company-names'],
};
