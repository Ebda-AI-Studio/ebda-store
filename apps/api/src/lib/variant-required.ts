import { AppError } from '../middleware/error-handler';

/**
 * C-01: a product with variants is sold as ONE of its variants, never as the
 * bare parent, on every path that writes a line: shopper cart (`CartService`),
 * admin manual order (`OrderService.createAdminOrder`), merchant payment link.
 * One bilingual refusal for all of them.
 */
export const VARIANT_REQUIRED_MESSAGE = {
  en: 'Choose the options for this product before adding it to the cart',
  ar: 'اختار مواصفات المنتج قبل ما تضيفه للسلة',
} as const;

/** Merchant-facing copy (admin order, payment link): names the product. */
export function variantRequiredError(productId?: string, productName?: string): AppError {
  if (!productName) {
    return new AppError(400, 'VARIANT_REQUIRED', VARIANT_REQUIRED_MESSAGE.en, {
      messageEn: VARIANT_REQUIRED_MESSAGE.en,
      messageAr: VARIANT_REQUIRED_MESSAGE.ar,
      ...(productId ? { productId } : {}),
    });
  }
  const messageEn = `Choose a size or option for “${productName}”`;
  const messageAr = `اختار المقاس أو المواصفات لـ «${productName}»`;
  return new AppError(400, 'VARIANT_REQUIRED', messageEn, {
    messageEn,
    messageAr,
    productId,
    productName,
  });
}
