import type { BillingInfo } from '../../../components/billing/types';

export type StepKey = 'plan' | 'store' | 'billing' | 'template' | 'product' | 'payment' | 'live';

export const STEP_ORDER: readonly StepKey[] = [
  'plan',
  'store',
  'billing',
  'template',
  'product',
  'payment',
  'live',
];

export type TemplateId = 'modern' | 'classic' | 'minimal' | 'bold' | 'elegant' | 'dahab';

export const TEMPLATE_IDS: readonly TemplateId[] = [
  'modern',
  'classic',
  'minimal',
  'bold',
  'elegant',
  'dahab',
];

export interface OnboardingStore {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive' | 'suspended';
  template: TemplateId;
  host: string;
  url: string;
  planCode: string | null;
}

export interface OnboardingState {
  user: { email: string; name: string; emailVerified: boolean };
  store: OnboardingStore | null;
  productCount: number;
  codEnabled: boolean;
  billing: BillingInfo | null;
}

export type SlugCheck =
  | { available: true; slug: string; host: string }
  | {
      available: false;
      slug: string;
      host: string;
      reason:
        | 'SLUG_TAKEN'
        | 'SLUG_RESERVED'
        | 'SLUG_PROTECTED'
        | 'SLUG_TOO_SHORT'
        | 'SLUG_TOO_LONG'
        | 'SLUG_INVALID_CHARS'
        | 'SLUG_INVALID_HYPHEN';
    };
