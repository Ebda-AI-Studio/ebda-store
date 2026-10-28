/**
 * THE emit port (CI-1): every emit site in the Store talks to `CommerceOutcomesPort` and nothing else.
 *
 * Today's adapter (`queueOutcomesPort`) puts validated envelopes on Queue `ebda-ci-events`. After the
 * Cloudflare cutover the StoreDO adapter writes the same envelopes into the `ci_outbox` table inside the
 * domain transaction and its alarm flushes them to the SAME queue; planners, envelope, consumer and
 * sink do not change. A CI failure must never fail the domain write: callers are retried jobs
 * (lib/inngest/functions/ci-outcomes.ts), so a throw here is a visible, retried job failure.
 */
import { cfBindings, type QueueProducerLike } from '../../cf/bindings';
import { BUYER_KEY_VERSION } from '@ebda/shared';
import logger from '../logger';
import {
  deterministicEventId,
  parseEnvelope,
  type CiEnvelope,
  type CiOutcomeInput,
} from './envelope';

export interface CommerceOutcomesPort {
  emit(inputs: CiOutcomeInput[]): Promise<void>;
}

export async function buildEnvelope(
  input: CiOutcomeInput,
  product: CiEnvelope['product'] = 'store',
  now: Date = new Date()
): Promise<CiEnvelope> {
  return parseEnvelope({
    v: 1,
    eventId: await deterministicEventId(`${input.seed}:${input.type}`),
    type: input.type,
    occurredAt: input.occurredAt.getTime(),
    recordedAt: now.getTime(),
    product,
    storeId: input.storeId,
    xstore: input.xstore,
    orderId: input.orderId,
    buyerKey: input.buyerKey,
    keyVersion: BUYER_KEY_VERSION,
    data: input.data,
  });
}

/** The Worker adapter. No Worker bindings at all (Node dev, unit tests) = nothing to write to: a no-op. */
export function queueOutcomesPort(
  queue: () => QueueProducerLike | undefined = () => cfBindings()?.CI_EVENTS_QUEUE as never
): CommerceOutcomesPort {
  return {
    async emit(inputs) {
      if (inputs.length === 0) return;
      const q = queue();
      if (!q) {
        if (cfBindings()) throw new Error('CI_EVENTS_QUEUE binding missing');
        logger.debug({ n: inputs.length }, '[ci] no Worker bindings, outcomes not captured');
        return;
      }
      const envelopes = await Promise.all(inputs.map(i => buildEnvelope(i)));
      for (const e of envelopes) await q.send(e, { contentType: 'json' });
    },
  };
}

let current: CommerceOutcomesPort | undefined;
export function commerceOutcomesPort(): CommerceOutcomesPort {
  return (current ??= queueOutcomesPort());
}
/** Test seam / the StoreDO cutover swaps the adapter here. */
export function setCommerceOutcomesPort(p: CommerceOutcomesPort | undefined): void {
  current = p;
}
