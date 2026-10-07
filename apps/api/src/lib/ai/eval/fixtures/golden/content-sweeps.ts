import type { GoldenCase } from '../types';

/** Golden fixtures: store-faq, howto-guide, meta-aeo, llms-txt, citation-copy, brand-facts, product-recommendations */
export const CONTENT_SWEEPS_GOLDEN: GoldenCase[] = [
  {
    id: 'store-faq-payment-methods',
    type: 'store-faq',
    input: { storeDescription: 'Egypt-based online store for handmade home goods.' },
    output: [
      {
        question: 'What payment methods do you accept?',
        questionAr: 'ما هي طرق الدفع المتاحة؟',
        answer: 'We accept Visa, Mastercard, Meeza, mobile wallets, and cash on delivery.',
        answerAr: 'نقبل الدفع عبر فيزا وماستركارد وميزة والمحافظ الإلكترونية والدفع عند الاستلام.',
      },
      {
        question: 'Do you deliver outside Cairo?',
        questionAr: 'هل توصلون خارج القاهرة؟',
        answer: 'Yes, we deliver to all Egypt governorates within 2-4 business days.',
        answerAr: 'نعم، نوصل إلى جميع محافظات مصر خلال 2 إلى 4 أيام عمل.',
      },
    ],
  },
  {
    id: 'howto-guide-place-order',
    type: 'howto-guide',
    input: { storeName: 'Demo Shop' },
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
      name: 'Demo Shop',
      description: 'Egypt-based online store for handmade home goods.',
    },
    output: {
      en: 'Demo Shop is an Egypt-based online store specialising in handmade home goods, from ceramics to textiles.',
      ar: 'وادي الجوز هو متجر إلكتروني مصري متخصص في المنتجات المنزلية اليدوية، من السيراميك إلى المنسوجات.',
    },
  },
  {
    id: 'llms-txt-basic-store',
    type: 'llms-txt',
    input: {
      storeName: 'Demo Shop',
      categoryNames: ['Kitchen & Dining', 'Home Decor'],
      productNames: ['Handmade Ceramic Mug'],
    },
    // URL shape must match bulk-ai-geo.ts's prompt (`${storeUrl}/products?
    // category=${c.slug}`) — apps/web has no `/categories/[slug]` route, so
    // the old `/categories/<slug>` shape below 404'd on every store that ran
    // this sweep (A4-2, 2026-09-22 AEO audit; see bulk-ai-geo.ts's comment).
    // A golden fixture asserting the dead shape would let that regression
    // pass this eval gate again.
    output:
      '# Demo Shop\n\n> Egypt-based online store for handmade home goods.\n\n## Store pages\n- Home: https://demo-shop.ebda.app\n\n## Product categories\n- Kitchen & Dining: https://demo-shop.ebda.app/products?category=kitchen-dining\n- Home Decor: https://demo-shop.ebda.app/products?category=home-decor\n\n## Notes\n- Bilingual (Arabic/English), currency EGP, ships within Egypt.',
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
      location: 'Egypt',
      keyCategories: ['Kitchen & Dining', 'Home Decor'],
      languages: ['Arabic', 'English'],
      contactMethods: ['email'],
      region: 'GCC',
      currency: 'EGP',
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
