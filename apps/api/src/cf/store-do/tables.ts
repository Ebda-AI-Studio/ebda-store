/** Parents before children (foreign keys): the order for restore; exports use the same order. */
export const STORE_TABLES = [
  'stores',
  'products',
  'product_variants',
  'carts',
  'cart_items',
  'orders',
  'order_items',
] as const;
