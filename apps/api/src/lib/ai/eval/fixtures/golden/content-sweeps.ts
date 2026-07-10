import type { GoldenCase } from '../types';

/** Golden fixtures: store-faq, howto-guide, meta-aeo, llms-txt, citation-copy, brand-facts, product-recommendations */
export const CONTENT_SWEEPS_GOLDEN: GoldenCase[] = [
  {
    id: 'store-faq-payment-methods',
    type: 'store-faq',
    input: { storeDescription: 'Kuwait-based online store for handmade home goods.' },
    output: [
      {
        question: 'What payment methods do you accept?',
        questionAr: 'ما هي طرق الدفع المتاحة؟',
        answer: 'We accept KNET, Visa, Mastercard, and Apple Pay.',
        answerAr: 'نقبل الدفع عبر كي نت وفيزا وماستركارد وآبل باي.',
      },
      {
        question: 'Do you deliver outside Kuwait City?',
        questionAr: 'هل توصلون خارج مدينة الكويت؟',
        answer: 'Yes, we deliver to all Kuwait governorates within 2-4 business days.',
        answerAr: 'نعم، نوصل إلى جميع محافظات الكويت خلال 2 إلى 4 أيام عمل.',
      },
    ],
  },
  {
    id: 'howto-guide-place-order',
    type: 'howto-guide',
    input: { storeName: 'Wady Aljuz' },
    output: [
      {
        title: 'How to Place an Order',
        titleAr: 'كيفية تقديم طلب',
        description: 'A quick walkthrough of ordering from our store.',
        descriptionAr: 'شرح سريع لكيفية الطلب من متجرنا.',
        steps: [
          { name: 'Browse products', text: 'Pick the items you like and add them to your cart.' },
          { name: 'Checkout', text: 'Enter your delivery details and choose a payment method.' },
          { name: 'Confirm', text: 'Review your order and confirm to place it.' },
        ],
        stepsAr: [
          { name: 'تصفح المنتجات', text: 'اختر المنتجات التي تعجبك وأضفها إلى السلة.' },
          { name: 'الدفع', text: 'أدخل تفاصيل التوصيل واختر طريقة الدفع.' },
          { name: 'التأكيد', text: 'راجع طلبك وأكده لإتمام الطلب.' },
        ],
      },
    ],
  },
  {
    id: 'meta-aeo-store',
    type: 'meta-aeo',
    input: {
      kind: 'store',
      name: 'Wady Aljuz',
      description: 'Kuwait-based online store for handmade home goods.',
    },
    output: {
      en: 'Wady Aljuz is a Kuwait-based online store specialising in handmade home goods, from ceramics to textiles.',
      ar: 'وادي الجوز هو متجر إلكتروني كويتي متخصص في المنتجات المنزلية اليدوية، من السيراميك إلى المنسوجات.',
    },
  },
  {
    id: 'llms-txt-basic-store',
    type: 'llms-txt',
    input: {
      storeName: 'Wady Aljuz',
      categoryNames: ['Kitchen & Dining', 'Home Decor'],
      productNames: ['Handmade Ceramic Mug'],
    },
    output:
      '# Wady Aljuz\n\n> Kuwait-based online store for handmade home goods.\n\n## Store pages\n- Home: https://store.force-ai.co/wady-aljuz\n\n## Product categories\n- Kitchen & Dining: https://store.force-ai.co/wady-aljuz/categories/kitchen-dining\n- Home Decor: https://store.force-ai.co/wady-aljuz/categories/home-decor\n\n## Notes\n- Bilingual (Arabic/English), currency KWD, ships within Kuwait.',
  },
  {
    id: 'citation-copy-mug',
    type: 'citation-copy',
    input: {
      productName: 'Handmade Ceramic Mug',
      description: 'A handmade ceramic mug, dishwasher safe, holds 350ml.',
    },
    output: {
      en: 'Handmade Ceramic Mug is a dishwasher-safe ceramic mug with a 350ml capacity.\n• Dishwasher safe\n• 350ml capacity',
      ar: 'كوب السيراميك اليدوي هو كوب سيراميك آمن لغسالة الصحون بسعة 350 مل.\n• آمن لغسالة الصحون\n• سعة 350 مل',
    },
  },
  {
    id: 'brand-facts-basic-store',
    type: 'brand-facts',
    input: { categoryNames: ['Kitchen & Dining', 'Home Decor'], hasEmail: true, hasPhone: false },
    output: {
      location: 'Kuwait',
      keyCategories: ['Kitchen & Dining', 'Home Decor'],
      languages: ['Arabic', 'English'],
      contactMethods: ['email'],
      region: 'GCC',
      currency: 'KWD',
    },
  },
  {
    id: 'product-recommendations-mug-to-coaster',
    type: 'product-recommendations',
    input: {
      sourceProductId: 'prod-mug',
      candidateIds: ['prod-coaster', 'prod-teapot', 'prod-tray'],
    },
    output: [
      {
        productId: 'prod-coaster',
        score: 0.9,
        reason: 'Ceramic coasters are frequently bought together with mugs.',
      },
      {
        productId: 'prod-teapot',
        score: 0.6,
        reason: 'Same ceramic collection, complementary drinkware.',
      },
    ],
  },
];
