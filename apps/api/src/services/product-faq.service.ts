import { storeDb, storeWriter } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';

/**
 * Product FAQ rows. ProductFaq has no storeId column, so EVERY function first proves the product belongs to the store
 * (404 otherwise): a store-A admin must never reach store-B FAQs by passing that product's id (the IDOR the
 * product-faq-tenant-scoping test guards). Extracted from the inline route handlers so the admin route and the Store
 * assistant call the same code.
 */
export interface ProductFaqInput {
  question: string;
  questionAr?: string | null;
  answer: string;
  answerAr?: string | null;
}

async function assertProductInStore(storeId: string, productId: string) {
  const w = await storeWriter(storeId);
  const product = await w.product.findFirst({
    where: { id: productId, storeId },
    select: { id: true },
  });
  if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  return w;
}

export async function listProductFaqs(storeId: string, productId: string) {
  await assertProductInStore(storeId, productId);
  return (await storeDb(storeId)).productFaq.findMany({
    where: { productId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createProductFaq(storeId: string, productId: string, body: ProductFaqInput) {
  const w = await assertProductInStore(storeId, productId);
  return w.productFaq.create({
    data: {
      productId,
      question: body.question,
      questionAr: body.questionAr ?? null,
      answer: body.answer,
      answerAr: body.answerAr ?? null,
      aiDrafted: false,
      manuallyEdited: true,
    },
  });
}

export async function deleteProductFaq(storeId: string, productId: string, faqId: string) {
  const w = await assertProductInStore(storeId, productId);
  const deleted = await w.productFaq.deleteMany({ where: { id: faqId, productId } });
  if (deleted.count === 0) throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
}
