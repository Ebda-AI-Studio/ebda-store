import type { KnownFailureCase } from '../types';

/** A rambling excerpt that blew past the 300-char cap instead of staying to 1-2 punchy sentences. */
export const productExcerptExceedsLength: KnownFailureCase = {
  id: 'product-excerpt-exceeds-length',
  type: 'product-excerpt',
  description:
    'Excerpt generator returned a multi-paragraph summary instead of a short 1-2 sentence excerpt.',
  input: {
    storeId: 'store-1',
    storeName: 'Test Store',
    product: {
      name: 'Handmade Ceramic Mug',
      description: 'A handmade ceramic mug, dishwasher safe, holds 350ml.',
    },
  },
  output: {
    excerpt:
      'This exquisite handmade ceramic mug is meticulously crafted by skilled artisans using traditional techniques passed down through generations, resulting in a truly unique piece that showcases the beauty of handcrafted pottery. '.repeat(
        2
      ),
    excerptAr: 'ملخص طويل جدًا يتجاوز الحد المسموح به بكثير. '.repeat(20),
  },
  expectedFailedChecks: ['within-length-bound'],
};
