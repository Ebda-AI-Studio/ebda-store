/**
 * Set-aside list for dead-lettered queue entries that cannot be parsed on
 * replay (issues 2292, 2353) — shared by the email and SMS queues.
 *
 * Bounded on every write: newest CORRUPT_CAP entries, and the list expires
 * CORRUPT_TTL_S after the last write. The entries are raw customer message
 * payloads, so this is a retention surface (docs/RETENTION.md), never a
 * forever-growing parking lot.
 */
export const CORRUPT_CAP = 200;
export const CORRUPT_TTL_S = 30 * 24 * 60 * 60;

interface ListClient {
  lpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export async function parkCorrupt(client: ListClient, key: string, raw: string): Promise<void> {
  await client.lpush(key, raw);
  await client.ltrim(key, 0, CORRUPT_CAP - 1);
  await client.expire(key, CORRUPT_TTL_S);
}

interface ReplayClient extends ListClient {
  llen(key: string): Promise<number>;
  rpop(key: string): Promise<string | null>;
}

export interface ReplayResult {
  /** Put back on the live queue. */
  retried: number;
  /** Unreadable — moved to the set-aside list. */
  skipped: number;
  /**
   * Left on (or put back onto) the dead-letter list because a Redis write
   * failed mid-replay (issue 2361) — still there for the next "Retry all".
   */
  kept: number;
  /**
   * Popped, and then BOTH the re-push and the put-back failed: the entry is
   * gone. Only reachable when Redis rejects two writes in a row; logged by id
   * (never payload) and alerted by the caller.
   */
  lost: number;
}

/**
 * Replay every entry of a dead-letter list onto its live queue — ONE loop for
 * the email and SMS queues, so the twins cannot drift (issues 2292, 2361).
 *
 * Every step after `rpop` is guarded: `rpop` has already removed the entry, so
 * a rejected write must never propagate out of the loop (that destroyed the
 * entry and abandoned every one behind it, 500ing the route with no audit
 * row). A failed re-push or set-aside puts the raw entry back on the
 * dead-letter list (`kept`) and the loop continues. A failed `rpop` removed
 * nothing, so it ends the run and the rest are reported as `kept`. The loop is
 * bounded by the list's length when it started, and a put-back goes to the
 * head (LPUSH) while replay pops the tail, so it is never re-popped this run.
 *
 * `isValid` must check EVERY field the consumer dereferences (issue 2371) —
 * an entry it admits is re-queued and then handed to the sender. Each queue
 * exports its predicate (`isQueuedEmail`, `isQueuedSms`) and uses the same one
 * in its dead-letter reader and live-queue processor, so reading, replaying
 * and sending agree on what "unreadable" means (issue 2374).
 */
export async function replayDeadLetters<T extends { attempts: number; error?: string }>(
  client: ReplayClient,
  keys: { failed: string; corrupt: string; queue: string },
  isValid: (parsed: unknown) => parsed is T,
  log: { error: (obj: object, msg: string) => void }
): Promise<ReplayResult> {
  const out: ReplayResult = { retried: 0, skipped: 0, kept: 0, lost: 0 };

  const putBack = async (raw: string, id: string | undefined, err: unknown) => {
    try {
      await client.lpush(keys.failed, raw);
      out.kept++;
      log.error({ err, id, list: keys.failed }, '[dead-letter] replay write failed — entry kept');
    } catch (err2) {
      out.lost++;
      log.error(
        { err: err2, firstErr: err, id, bytes: raw.length, list: keys.failed },
        '[dead-letter] replay write AND put-back failed — entry lost'
      );
    }
  };

  const total = await client.llen(keys.failed);
  for (let i = 0; i < total; i++) {
    let raw: string | null;
    try {
      raw = await client.rpop(keys.failed);
    } catch (err) {
      // Nothing was removed: the rest are still on the list.
      out.kept += total - i;
      log.error({ err, list: keys.failed }, '[dead-letter] rpop failed — replay stopped');
      break;
    }
    if (!raw) break;

    let entry: T;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValid(parsed)) throw new Error('bad shape');
      entry = parsed;
    } catch {
      try {
        await parkCorrupt(client, keys.corrupt, raw);
        out.skipped++;
        log.error(
          { bytes: raw.length, list: keys.corrupt },
          '[dead-letter] unreadable entry set aside'
        );
      } catch (err) {
        await putBack(raw, undefined, err);
      }
      continue;
    }

    entry.attempts = 0;
    entry.error = undefined;
    try {
      await client.lpush(keys.queue, JSON.stringify(entry));
      out.retried++;
    } catch (err) {
      await putBack(raw, (entry as { id?: string }).id, err);
    }
  }
  return out;
}
