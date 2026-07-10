import type { KnownFailureCase } from '../types';

/**
 * THE reported regression (merchant, 2026-07-09 → fixed in PR #538,
 * commit 6ec89b0a): product FAQs that near-verbatim restate the product
 * description instead of adding new information. This fixture pins that
 * defect class so it can never silently regress again.
 */
export const productFaqDuplicatesDescription: KnownFailureCase = {
  id: 'product-faq-duplicates-description',
  type: 'product-faq',
  description:
    'Merchant-reported bug (2026-07-09): FAQ answer is a near-verbatim restatement of the product description instead of new information.',
  input: {
    storeId: 'store-1',
    storeName: 'Test Store',
    product: {
      name: 'Classic Cotton T-Shirt',
      description: 'A 100% cotton crew-neck t-shirt, machine washable, available in navy blue.',
    },
    count: 2,
  },
  output: [
    {
      question: 'What is this t-shirt made of?',
      questionAr: 'مما يصنع هذا القميص؟',
      answer:
        'This is a 100% cotton crew-neck t-shirt that is machine washable and available in navy blue.',
      answerAr:
        'هذا قميص قطني 100% بياقة مستديرة، قابل للغسل في الغسالة ومتوفر باللون الأزرق الداكن.',
    },
    {
      question: 'What is the return policy?',
      questionAr: 'ما هي سياسة الإرجاع؟',
      answer: 'You can return the item within our standard return window if it does not fit.',
      answerAr: 'يمكنك إرجاع المنتج ضمن فترة الإرجاع القياسية إذا لم يكن المقاس مناسبًا.',
    },
  ],
  expectedFailedChecks: ['no-description-duplication'],
};
