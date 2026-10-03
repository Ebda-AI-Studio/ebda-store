import type { GoldenCase } from '../types';

/** Golden fixtures: product-faq, product-excerpt, product-alt-text, product-category-suggestion, product-tags */
export const PRODUCT_CONTENT_GOLDEN: GoldenCase[] = [
  {
    id: 'product-faq-ceramic-mug',
    type: 'product-faq',
    input: {
      storeId: 'store-1',
      storeName: 'Wady Aljuz',
      product: {
        name: 'Handmade Ceramic Mug',
        nameAr: 'كوب سيراميك يدوي الصنع',
        description: 'A handmade ceramic mug, dishwasher safe, holds 350ml.',
      },
      count: 3,
    },
    output: [
      {
        question: 'Can I put this mug in the microwave?',
        questionAr: 'هل يمكنني وضع هذا الكوب في الميكروويف؟',
        answer:
          'The product listing does not specify microwave safety — for handmade ceramics we recommend checking with us before microwaving to avoid damaging the glaze.',
        answerAr:
          'لا يحدد وصف المنتج ما إذا كان آمنًا للميكروويف — نوصي بالتواصل معنا قبل استخدامه في الميكروويف لتجنب تلف الطلاء.',
      },
      {
        question: 'How long does delivery take in Egypt?',
        questionAr: 'كم تستغرق مدة التوصيل داخل مصر؟',
        answer: 'Standard delivery within Egypt takes 2-4 business days from order confirmation.',
        answerAr: 'يستغرق التوصيل القياسي داخل مصر من 2 إلى 4 أيام عمل من تاريخ تأكيد الطلب.',
      },
      {
        question: 'What is the return policy if the mug arrives damaged?',
        questionAr: 'ما هي سياسة الإرجاع في حال وصول الكوب متضررًا؟',
        answer:
          'You can request a return or exchange within our standard return window if the item arrives damaged.',
        answerAr:
          'يمكنك طلب استرجاع أو استبدال ضمن فترة الإرجاع القياسية في حال وصول المنتج متضررًا.',
      },
    ],
  },
  {
    id: 'product-excerpt-ceramic-mug',
    type: 'product-excerpt',
    input: {
      storeId: 'store-1',
      storeName: 'Wady Aljuz',
      product: {
        name: 'Handmade Ceramic Mug',
        nameAr: 'كوب سيراميك يدوي الصنع',
        description: 'A handmade ceramic mug, dishwasher safe, holds 350ml.',
        descriptionAr: 'كوب سيراميك يدوي الصنع، آمن للاستخدام في غسالة الصحون، يتسع لـ 350 مل.',
      },
    },
    output: {
      excerpt: 'Handmade 350ml ceramic mug, dishwasher safe.',
      excerptAr: 'كوب سيراميك يدوي الصنع بسعة 350 مل، آمن لغسالة الصحون.',
    },
  },
  {
    id: 'product-alt-text-ceramic-mug',
    type: 'product-alt-text',
    input: {
      storeId: 'store-1',
      imageUrl: 'https://example.com/mug.jpg',
      product: { name: 'Handmade Ceramic Mug', nameAr: 'كوب سيراميك يدوي الصنع' },
    },
    output:
      'Cream-glazed handmade ceramic mug with a curved handle, photographed on a wooden table',
  },
  {
    id: 'product-category-suggestion-mug-to-kitchen',
    type: 'product-category-suggestion',
    input: {
      storeId: 'store-1',
      storeName: 'Wady Aljuz',
      product: {
        name: 'Handmade Ceramic Mug',
        description: 'A handmade ceramic mug, dishwasher safe.',
      },
      existingCategories: [
        { id: 'cat-kitchen', name: 'Kitchen & Dining', nameAr: 'المطبخ وتناول الطعام' },
        { id: 'cat-decor', name: 'Home Decor', nameAr: 'ديكور المنزل' },
      ],
    },
    output: [{ id: 'cat-kitchen', confidence: 'high' }],
  },
  {
    id: 'product-tags-mug',
    type: 'product-tags',
    input: {
      storeId: 'store-1',
      storeName: 'Wady Aljuz',
      product: {
        name: 'Handmade Ceramic Mug',
        description: 'A handmade ceramic mug, dishwasher safe.',
      },
      existingTagNames: ['handmade', 'ceramic'],
    },
    output: ['handmade', 'ceramic', 'mug', 'kitchen'],
  },
];
