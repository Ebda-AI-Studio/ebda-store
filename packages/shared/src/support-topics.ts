/** Topics of the in-product "Contact Ebda Store" request (SELF-SERVICE A14). Shared by the API schema and the admin form. */
export const SUPPORT_TOPICS = [
  'billing',
  'plan',
  'orders',
  'products',
  'payments',
  'shipping',
  'domain',
  'three_d_models',
  'account',
  'other',
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];
