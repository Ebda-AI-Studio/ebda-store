/**
 * Replay of parked dead letters (`dlq/`, lib/ci/sink.ts) back onto the CI events queue, after the cause
 * was fixed. It refuses a body older than the tombstone TTL (an erasure's tombstone may have expired, so
 * the body could resurrect erased data), and one whose order or store+buyer is tombstoned (the sink would
 * drop it anyway; refusing here deletes the body so it is not kept).
 */
import type { QueueProducerLike } from '../../cf/bindings';
import type { CiBucket } from './erase';
import { parseEnvelope } from './envelope';
import { CI_TOMBSTONE_DAYS, ciBuyerTombstoneKey, ciOrderTombstoneKey } from './layout';

export async function replayCiDlq(
  ci: CiBucket,
  queue: QueueProducerLike,
  now = Date.now()
): Promise<{ replayed: number; refusedOld: number; refusedErased: number; unreadable: number }> {
  const out = { replayed: 0, refusedOld: 0, refusedErased: 0, unreadable: 0 };
  const maxAge = CI_TOMBSTONE_DAYS * 86_400_000;
  let cursor: string | undefined;
  do {
    const page = await ci.list({ prefix: 'dlq/', cursor, limit: 500 });
    for (const { key } of page.objects) {
      const o = await ci.get(key);
      if (!o) continue;
      let parked: { parkedAt?: number; body?: unknown };
      try {
        parked = JSON.parse(await o.text());
      } catch {
        out.unreadable++;
        continue;
      }
      if (typeof parked.parkedAt !== 'number' || now - parked.parkedAt > maxAge) {
        out.refusedOld++;
        await ci.delete(key);
        continue;
      }
      let env;
      try {
        env = parseEnvelope(parked.body);
      } catch {
        out.unreadable++;
        continue;
      }
      if (
        (env.orderId && (await ci.get(ciOrderTombstoneKey(env.orderId)))) ||
        (env.buyerKey && (await ci.get(ciBuyerTombstoneKey(env.storeId, env.buyerKey))))
      ) {
        out.refusedErased++;
        await ci.delete(key);
        continue;
      }
      await queue.send(env, { contentType: 'json' });
      await ci.delete(key);
      out.replayed++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}
