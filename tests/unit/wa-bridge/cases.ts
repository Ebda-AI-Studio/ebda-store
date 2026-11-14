import { S, S_UNLINKED, S_UNKNOWN, BK, BK_OTHER, BUYER } from './fake-port';
const idem = (n: number) => `example-idem-${String(n).padStart(4, '0')}`;
const AT = '2026-11-11T10:00:00.000Z';
/** Ordered: the world is stateful (an order placed in case 9 is read in case 14). Args only; expectations live in the fixture. */
export const CASES: Array<{ name: string; method: string; args: unknown[] }> = [
  { name: 'profile', method: 'getStoreProfile', args: [S] },
  {
    name: 'profile of a store that does not resolve is not_found, never a default',
    method: 'getStoreProfile',
    args: [S_UNKNOWN],
  },
  {
    name: 'profile of an unlinked store is not_linked',
    method: 'getStoreProfile',
    args: [S_UNLINKED],
  },
  { name: 'malformed store id is invalid', method: 'getStoreProfile', args: ['not-a-uuid'] },
  { name: 'catalog page 1', method: 'listCatalog', args: [S, null, 2] },
  { name: 'catalog page 2', method: 'listCatalog', args: [S, 'v2', 2] },
  { name: 'catalog limit over 100 is invalid', method: 'listCatalog', args: [S, null, 101] },
  { name: 'products by id', method: 'getProducts', args: [S, ['v1', 'v3']] },
  {
    name: 'checkout link refuses a sold-out variant',
    method: 'createCheckoutLink',
    args: [S, { items: [{ variantId: 'v3', quantity: 1 }], buyer: BUYER }],
  },
  {
    name: 'cod order',
    method: 'createOrderFromChat',
    args: [
      S,
      {
        items: [{ variantId: 'v1', quantity: 2 }],
        buyer: BUYER,
        address: { area: 'Nasr City', street: '5 Abbas El Akkad' },
        paymentMethod: 'cod',
        idempotencyKey: idem(1),
      },
    ],
  },
  {
    name: 'cod order replay returns the same order',
    method: 'createOrderFromChat',
    args: [
      S,
      {
        items: [{ variantId: 'v1', quantity: 2 }],
        buyer: BUYER,
        address: { area: 'Nasr City', street: '5 Abbas El Akkad' },
        paymentMethod: 'cod',
        idempotencyKey: idem(1),
      },
    ],
  },
  {
    name: 'link order carries a payment url',
    method: 'createOrderFromChat',
    args: [
      S,
      {
        items: [{ variantId: 'v2', quantity: 1 }],
        buyer: BUYER,
        addressId: 'a1',
        paymentMethod: 'link',
        idempotencyKey: idem(2),
      },
    ],
  },
  {
    name: 'instapay order carries ipa, amount and reference',
    method: 'createOrderFromChat',
    args: [
      S,
      {
        items: [{ variantId: 'v1', quantity: 1 }],
        buyer: BUYER,
        addressId: 'a1',
        paymentMethod: 'instapay',
        idempotencyKey: idem(3),
      },
    ],
  },
  {
    name: 'sold-out line is out_of_stock with the variant ids',
    method: 'createOrderFromChat',
    args: [
      S,
      {
        items: [{ variantId: 'v3', quantity: 1 }],
        buyer: BUYER,
        addressId: 'a1',
        paymentMethod: 'cod',
        idempotencyKey: idem(4),
      },
    ],
  },
  {
    name: 'an order without an idempotency key is invalid',
    method: 'createOrderFromChat',
    args: [
      S,
      {
        items: [{ variantId: 'v1', quantity: 1 }],
        buyer: BUYER,
        addressId: 'a1',
        paymentMethod: 'cod',
      },
    ],
  },
  {
    name: 'both address and addressId is invalid',
    method: 'createOrderFromChat',
    args: [
      S,
      {
        items: [{ variantId: 'v1', quantity: 1 }],
        buyer: BUYER,
        addressId: 'a1',
        address: { area: 'x', street: 'y' },
        paymentMethod: 'cod',
        idempotencyKey: idem(5),
      },
    ],
  },
  {
    name: 'unknown address is not_found',
    method: 'createOrderFromChat',
    args: [
      S,
      {
        items: [{ variantId: 'v1', quantity: 1 }],
        buyer: BUYER,
        addressId: 'nope',
        paymentMethod: 'cod',
        idempotencyKey: idem(6),
      },
    ],
  },
  { name: 'payment link for an open order', method: 'getPaymentLink', args: [S, 'o-1002', BK] },
  { name: 'payment link for an unknown order', method: 'getPaymentLink', args: [S, 'o-9999', BK] },
  {
    name: 'cod confirmed',
    method: 'recordCodOutcome',
    args: [
      S,
      { orderId: 'o-1001', buyerKey: BK, outcome: 'confirmed', at: AT, idempotencyKey: idem(7) },
    ],
  },
  {
    name: 'cod confirmed replay is the same answer',
    method: 'recordCodOutcome',
    args: [
      S,
      { orderId: 'o-1001', buyerKey: BK, outcome: 'confirmed', at: AT, idempotencyKey: idem(7) },
    ],
  },
  {
    name: 'cod outcome for an unknown order',
    method: 'recordCodOutcome',
    args: [
      S,
      { orderId: 'o-9999', buyerKey: BK, outcome: 'refused', at: AT, idempotencyKey: idem(8) },
    ],
  },
  {
    name: 'cod outcome without an idempotency key is invalid',
    method: 'recordCodOutcome',
    args: [S, { orderId: 'o-1001', buyerKey: BK, outcome: 'refused', at: AT }],
  },
  {
    name: 'proof on an instapay order',
    method: 'attachPaymentProof',
    args: [S, 'o-1003', 'https://media.example/proof.jpg', BK],
  },
  {
    name: 'proof on a non-instapay order is not_found',
    method: 'attachPaymentProof',
    args: [S, 'o-1001', 'https://media.example/proof.jpg', BK],
  },
  {
    name: 'proof url must be https',
    method: 'attachPaymentProof',
    args: [S, 'o-1003', 'http://media.example/proof.jpg', BK],
  },
  { name: 'saved addresses', method: 'getCustomerAddresses', args: [S, BK, BUYER.phoneE164] },
  {
    name: 'save an address',
    method: 'saveCustomerAddress',
    args: [S, BK, { label: 'Work', area: 'Zamalek', street: '1 Brazil St' }, BUYER.phoneE164],
  },
  {
    name: 'save an address for a buyer with no customer yet creates it',
    method: 'saveCustomerAddress',
    args: [S, BK_OTHER, { area: 'Zamalek', street: '1 Brazil St' }, '+201112345678'],
  },
  {
    name: 'saving the same address again is idempotent',
    method: 'saveCustomerAddress',
    args: [S, BK_OTHER, { area: 'Zamalek', street: '1 Brazil St' }, '+201112345678'],
  },
  {
    name: 'order status by number and buyer',
    method: 'getOrderStatus',
    args: [S, 'EB-1001', BK, BUYER.phoneE164],
  },
  {
    name: 'order status for another buyer never leaks',
    method: 'getOrderStatus',
    args: [S, 'EB-1001', BK_OTHER, '+201112345678'],
  },
  { name: 'customer orders', method: 'listCustomerOrders', args: [S, BK, 5, BUYER.phoneE164] },
];
