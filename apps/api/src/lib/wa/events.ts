/**
 * Store -> WhatsApp producer (contract section 4): builds the envelope, validates it with the
 * SHARED schema (contracts/ebda-wa-v1.ts, pinned to the WhatsApp repo's bytes) and enqueues it on
 * `ebda-wa-events`. It throws on a bad payload or a failed enqueue: the callers are retried jobs
 * (lib/wa/store-events-job.ts), so a failure is visible and retried, never a silent drop.
 */
import { cfBindings } from '../../cf/bindings';
import { storeEventSchema, type StoreEvent } from '../../contracts/ebda-wa-v1';

type Distribute<T> = T extends { type: infer K }
  ? Omit<T, 'id' | 'v' | 'occurredAt'> & { type: K }
  : never;
export type StoreEventInput = Distribute<StoreEvent>;

/**
 * A UUID derived from a seed, so a retry of the same source event produces the SAME envelope id
 * (the consumer dedupes on it). Shaped as a v4 uuid because the schema asks for `uuid()`.
 */
export async function deterministicEventId(seed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ebda-wa-v1:${seed}`))
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function buildStoreEvent(
  input: StoreEventInput,
  opts: { seed: string; occurredAt?: Date }
): Promise<StoreEvent> {
  return storeEventSchema.parse({
    ...input,
    id: await deterministicEventId(`${opts.seed}:${input.type}`),
    v: 1,
    occurredAt: (opts.occurredAt ?? new Date()).toISOString(),
  });
}

export async function sendStoreEvents(events: StoreEvent[]): Promise<void> {
  const queue = cfBindings()?.WA_EVENTS_QUEUE;
  if (!queue) throw new Error('WA_EVENTS_QUEUE binding missing');
  for (const e of events) await queue.send(e, { contentType: 'json' });
}
