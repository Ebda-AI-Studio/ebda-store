import type { KnownFailureCase } from '../types';

/** Alt-text generator degenerated to just echoing the product name — no visible-attribute description, defeating the SEO/a11y purpose. */
export const productAltTextJustProductName: KnownFailureCase = {
  id: 'product-alt-text-just-product-name',
  type: 'product-alt-text',
  description:
    'Alt text is identical to the product name — adds no visual description for SEO/screen readers.',
  input: {
    storeId: 'store-1',
    imageUrl: 'https://example.com/mug.jpg',
    product: { name: 'Handmade Ceramic Mug' },
  },
  output: 'Handmade Ceramic Mug',
  expectedFailedChecks: ['not-just-the-product-name'],
};
