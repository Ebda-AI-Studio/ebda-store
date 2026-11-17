/** Small emit helpers shared by several write paths (kept free of service imports so none of them can cycle). */
import { sendEventAfterCommit } from '../inngest/send-after-commit';
import {
  CI_CART_RECOVERED_EVENT,
  CI_ONBOARDING_HELP_EVENT,
  CI_ONBOARDING_STEP_EVENT,
} from './events';
import type { ONBOARDING_HELP_KINDS, ONBOARDING_STEPS } from './envelope';

/** CI-13: an order replaced a reminded cart. The planner drops it when no reminder had gone out. */
export async function sendCartRecoveredToCi(
  storeId: string,
  abandonedCartId: string,
  orderId: string
): Promise<void> {
  await sendEventAfterCommit(
    'ci-cart-recovered',
    {
      name: CI_CART_RECOVERED_EVENT,
      data: { storeId, abandonedCartId, orderId, at: new Date().toISOString() },
    },
    { ifUnhookable: 'send' }
  );
}

/** CI-13: a store-setup milestone. One event per (store, step): the planner's seed makes a repeat harmless. */
export async function sendOnboardingStepToCi(
  storeId: string,
  step: (typeof ONBOARDING_STEPS)[number]
): Promise<void> {
  await sendEventAfterCommit(
    'ci-onboarding-step',
    { name: CI_ONBOARDING_STEP_EVENT, data: { storeId, step, at: new Date().toISOString() } },
    { ifUnhookable: 'send' }
  );
}

/**
 * CI-14 / Ruling ACT-1: the merchant needed help (used the Ebda AI assistant, or a super admin wrote to the store before it
 * went live). Ids only. The planner works out which step was open and drops it for an established store.
 */
export async function sendOnboardingHelpToCi(
  storeId: string,
  kind: (typeof ONBOARDING_HELP_KINDS)[number]
): Promise<void> {
  await sendEventAfterCommit(
    'ci-onboarding-help',
    { name: CI_ONBOARDING_HELP_EVENT, data: { storeId, kind, at: new Date().toISOString() } },
    { ifUnhookable: 'send' }
  );
}
