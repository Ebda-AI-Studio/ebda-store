/** STORE-QA-33: `/orders/invoices` (a guessed sub-path) is not an order id: the page answers 404, never an endless "loading order". */
export function isOrderId(value: string | null | undefined): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '');
}
