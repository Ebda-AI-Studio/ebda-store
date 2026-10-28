import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { eraseCiOutcomes } from './account-erased-propagation';

/**
 * Customer Intelligence erasure, second pass (Ruling CI-7). Its OWN function on `account/erased`, so its
 * retries and its 2 h sleep are independent of OneSignal / PostHog / the first CI pass: a failing sibling
 * can never skip it. After the queue's retry window it lists the store's partitions (from the account's
 * first order day on) instead of trusting the buyer index, which also catches a row whose index entry lost
 * a race with the sink, and a row stored under another key.
 */
type Step = {
  sleep(id: string, d: string): Promise<unknown>;
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
};
type Data = {
  userId?: string;
  ciScope?: { storeId: string; orderIds: string[]; buyerKeys: string[]; sinceDay?: string };
  ciProven?: { storeId: string; buyerKeys: string[] };
};

export async function ciErasureSecondPass(event: { data: Data }, step: Step) {
  const { userId, ciScope, ciProven } = event.data;
  if (!userId || !(ciScope?.orderIds?.length || ciProven?.buyerKeys.length))
    return { skipped: true };
  await step.sleep('ci-erasure-settle', '2h');
  const r = await step.run('erase-ci-outcomes-second-pass', () =>
    eraseCiOutcomes(userId, ciScope, ciProven, undefined, 'prefix')
  );
  return { skipped: false, ...r };
}

export const ciErasureSecondPassFn: JobDef = inngest.createFunction(
  {
    id: 'ci-erasure-second-pass',
    name: 'Customer Intelligence: erasure second pass (2 h after the first)',
    retries: 5,
    triggers: [{ event: 'account/erased' }],
  },
  async ({ event, step }) => ciErasureSecondPass(event as never, step as never)
);
