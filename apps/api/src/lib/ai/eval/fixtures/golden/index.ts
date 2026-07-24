import type { GoldenCase } from '../types';
import { PRODUCT_CONTENT_GOLDEN } from './product-content';
import { STORE_CONTENT_GOLDEN } from './store-content';
import { CONTENT_SWEEPS_GOLDEN } from './content-sweeps';
import { REVIEWS_GOLDEN } from './reviews';
import { ACCOUNTING_GOLDEN } from './accounting';

/** Every golden (input, output) case across every AI output type. Each MUST pass its type's deterministic checks. */
export const GOLDEN_CASES: GoldenCase[] = [
  ...PRODUCT_CONTENT_GOLDEN,
  ...STORE_CONTENT_GOLDEN,
  ...CONTENT_SWEEPS_GOLDEN,
  ...REVIEWS_GOLDEN,
  ...ACCOUNTING_GOLDEN,
];
