/** Inngest event names that feed CI capture (kept dependency-free so emit sites can import them). */
export const CI_SHIPMENT_BOOKED_EVENT = 'ci/shipment-booked';
/** Sent by the shipment status writer ONLY when a first-time fact (pick-up, attempt, delivery, return) is new. */
export const CI_SHIPMENT_TRACKED_EVENT = 'ci/shipment-tracked';
