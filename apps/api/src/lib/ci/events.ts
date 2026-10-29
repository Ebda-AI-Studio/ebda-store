/** Inngest event names that feed CI capture (kept dependency-free so emit sites can import them). */
export const CI_SHIPMENT_BOOKED_EVENT = 'ci/shipment-booked';
/** Sent by the shipment status writer ONLY when a first-time fact (pick-up, attempt, delivery, return) is new. */
export const CI_SHIPMENT_TRACKED_EVENT = 'ci/shipment-tracked';
/** A gateway or webhook settled a payment as failed / expired / cancelled (sent only by the call that WON the order claim). */
export const CI_PAYMENT_FAILED_EVENT = 'ci/payment-failed';
/** An abandoned-cart reminder went out (push/SMS/WhatsApp step, or the recovery email). */
export const CI_CART_REMINDER_EVENT = 'ci/cart-reminder-sent';
/** An order replaced an abandoned cart that had been reminded. */
export const CI_CART_RECOVERED_EVENT = 'ci/cart-recovered';
/** A store-setup milestone was reached (store created, payment methods chosen, went live). */
export const CI_ONBOARDING_STEP_EVENT = 'ci/onboarding-step';
