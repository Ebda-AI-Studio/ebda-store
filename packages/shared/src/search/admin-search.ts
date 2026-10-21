/**
 * Contract of `GET /api/v1/stores/:storeId/search?q=` (search program P2, Task 18): the admin ⌘K
 * palette's record lookup. Five of each kind at most; a kind the caller may not read is an empty
 * list (indistinguishable from "no match").
 */
export interface AdminSearchResponse {
  products: Array<{ id: string; name: string; nameAr: string | null; sku: string | null }>;
  /** `total` in piastres, like every money field of the order API. */
  orders: Array<{ id: string; orderNumber: string; customerName: string; total: number }>;
  /**
   * `key` is the Customers-page key (`customerKeyOf`): a registered customer's user id, or a guest's
   * lowercased email (else phone). It is the `:customerKey` of `/stores/:id/customers/:customerKey`.
   */
  customers: Array<{ key: string; name: string; phone: string; isGuest: boolean }>;
}
