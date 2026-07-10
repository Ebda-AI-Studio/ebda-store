import type { GoldenCase } from '../types';

/** Golden fixtures: translation, seo-meta, section-copy, description-balance, logo-palette */
export const STORE_CONTENT_GOLDEN: GoldenCase[] = [
  {
    id: 'translation-name-en-to-ar',
    type: 'translation',
    input: { text: 'Handmade Ceramic Mug', from: 'en', to: 'ar', kind: 'product-name' },
    output: { translation: 'كوب سيراميك يدوي الصنع' },
  },
  {
    id: 'translation-meta-title-ar-to-en',
    type: 'translation',
    input: { text: 'أفضل متجر إلكتروني في الكويت', from: 'ar', to: 'en', kind: 'meta-title' },
    output: { translation: 'Best Online Store in Kuwait' },
  },
  {
    id: 'seo-meta-product',
    type: 'seo-meta',
    input: {
      kind: 'product',
      entityName: 'Handmade Ceramic Mug',
      entityDescription: 'A handmade ceramic mug, dishwasher safe, holds 350ml.',
    },
    output: {
      title: 'Handmade Ceramic Mug | Wady Aljuz',
      titleAr: 'كوب سيراميك يدوي الصنع | وادي الجوز',
      description:
        'Shop our handmade 350ml ceramic mug, dishwasher safe and perfect for everyday use in Kuwait.',
      descriptionAr:
        'تسوق كوب السيراميك يدوي الصنع بسعة 350 مل، آمن لغسالة الصحون ومثالي للاستخدام اليومي في الكويت.',
      keywords: ['ceramic mug kuwait', 'handmade mug', 'كوب سيراميك', 'kitchenware kuwait'],
    },
  },
  {
    id: 'section-copy-new-arrivals',
    type: 'section-copy',
    input: { section: 'newArrivals', storeName: 'Wady Aljuz', existingTitle: 'New Arrivals' },
    output: {
      kicker: 'JUST IN',
      kickerAr: 'وصل حديثاً',
      subtitle: 'Fresh picks added every week',
      subtitleAr: 'قطع جديدة تضاف كل أسبوع',
    },
  },
  {
    id: 'description-balance-arabic-authoritative',
    type: 'description-balance',
    input: {
      name: null,
      nameAr: 'كوب سيراميك يدوي الصنع',
      description: null,
      descriptionAr: 'كوب سيراميك يدوي الصنع، يتسع لـ 350 مل.',
    },
    output: {
      name: 'Handmade Ceramic Mug',
      nameAr: 'كوب سيراميك يدوي الصنع',
      description: 'Handmade ceramic mug, holds 350ml.',
      descriptionAr: 'كوب سيراميك يدوي الصنع، يتسع لـ 350 مل.',
    },
  },
  {
    id: 'logo-palette-orange-brand',
    type: 'logo-palette',
    input: { logoUrl: 'https://example.com/logo.png' },
    output: { primary: '#FF6E01', accent: '#1A1A1A', neutral: '#F5F0E8' },
  },
];
