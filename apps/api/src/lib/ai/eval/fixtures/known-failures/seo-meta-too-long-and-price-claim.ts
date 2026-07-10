import type { KnownFailureCase } from '../types';

/** SEO title blew the 60-char cap AND the description mentions a price, both explicit violations of the ai.service.ts prompt's own rules. */
export const seoMetaTooLongAndPriceClaim: KnownFailureCase = {
  id: 'seo-meta-too-long-and-price-claim',
  type: 'seo-meta',
  description:
    'SEO title exceeds 60 chars and the description mentions a KWD price (prompt explicitly forbids price mentions).',
  input: {
    kind: 'product',
    entityName: 'Handmade Ceramic Mug',
    entityDescription: 'A handmade ceramic mug, dishwasher safe, holds 350ml.',
  },
  output: {
    title: 'Buy the Best Handmade Ceramic Mug Online in Kuwait Today at Great Prices',
    titleAr: 'اشترِ أفضل كوب سيراميك يدوي الصنع عبر الإنترنت في الكويت اليوم بأسعار رائعة',
    description:
      'Shop this handmade ceramic mug now for only 3.5 KWD, dishwasher safe and perfect for daily use.',
    descriptionAr:
      'تسوق كوب السيراميك اليدوي الآن مقابل 3.5 دينار كويتي فقط، آمن لغسالة الصحون ومثالي للاستخدام اليومي.',
    keywords: ['ceramic mug kuwait', 'handmade mug', 'كوب سيراميك'],
  },
  expectedFailedChecks: ['title-within-60-chars', 'no-price-or-stock-claims'],
};
