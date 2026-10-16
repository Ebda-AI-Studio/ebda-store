/**
 * The cart's checkout action has ONE label at every breakpoint (C-03): the
 * desktop order summary (every skin), the fallback summary, the phone sticky
 * total and the Dahab bag drawer all read this. The desktop summary said
 * "المتابعة للدفع" while the phone bar said "إتمام الطلب"; one action, two names.
 * Pinned by tests/unit/cart-checkout-cta.test.tsx.
 */
export const CART_CHECKOUT_CTA = { en: 'Checkout', ar: 'إتمام الطلب' } as const;
