import { AppError } from '../middleware/error-handler';
import { storeDb, storeWriter } from '../lib/repo-factory';

/**
 * Store-level FAQ writes (the `store_faqs` table). Extracted from routes/store.routes.ts (POST/PUT /:id/faqs) so the admin route and the Ebda
 * Store assistant (`faq_create` / `faq_update`) call ONE write path. Behaviour is the route's, unchanged: a manual write marks the row
 * `manuallyEdited` so the AI bulk sweep never overwrites it (NEVER-OVERWRITE-1).
 */
interface StoreFaqInput {
  question: string;
  questionAr?: string | null;
  answer: string;
  answerAr?: string | null;
  orderIndex?: number;
  isActive?: boolean;
}

export const StoreFaqService = {
  /** One FAQ of this store; 404 for an id that is not in it (never another store's row). */
  async get(storeId: string, faqId: string) {
    const faq = await (
      await storeDb(storeId)
    ).storeFaq.findUnique({ where: { id: faqId, storeId } });
    if (!faq) throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
    return faq;
  },

  async create(storeId: string, body: StoreFaqInput) {
    return (await storeWriter(storeId)).storeFaq.create({
      data: {
        storeId,
        question: body.question,
        questionAr: body.questionAr ?? null,
        answer: body.answer,
        answerAr: body.answerAr ?? null,
        orderIndex: body.orderIndex ?? 0,
        isActive: body.isActive ?? true,
        aiDrafted: false,
        manuallyEdited: true,
      },
    });
  },

  async update(storeId: string, faqId: string, body: Partial<StoreFaqInput>) {
    const res = await (
      await storeWriter(storeId)
    ).storeFaq.updateMany({
      where: { id: faqId, storeId },
      data: {
        ...(body.question !== undefined && { question: body.question }),
        ...(body.questionAr !== undefined && { questionAr: body.questionAr }),
        ...(body.answer !== undefined && { answer: body.answer }),
        ...(body.answerAr !== undefined && { answerAr: body.answerAr }),
        ...(body.orderIndex !== undefined && { orderIndex: body.orderIndex }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        manuallyEdited: true,
      },
    });
    if (res.count === 0) throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
    return (await storeDb(storeId)).storeFaq.findUnique({ where: { id: faqId, storeId } });
  },
};
