/**
 * A client Idempotency-Key for a money-OUT request whose effect spans several steps (a gateway refund: claim, provider call,
 * completion). Same key -> the first answer again, never a second effect (review M-8 of PR 455, Ruling NZ-MONEY-3).
 *
 * The claim is one atomic `SET NX EX` on the strongly consistent store (`redis.service`: the AuthState Durable Object on the
 * Worker). States: `pending` while the first request runs, then the JSON answer. A request that FAILED before any money moved
 * releases the key (a retry may try again); a failure after which the money MAY have moved keeps it `pending`, so a retry is
 * refused 409 and a human checks the provider (the same rule as `REFUND_ALREADY_ISSUED`). No key = the old behaviour, except
 * for a scope called with `{ required: true }` (a refund to a payment provider, #628): there a missing key is a 400 and
 * nothing runs, because a keyless retry after an indeterminate failure is exactly the double refund this exists to stop.
 * Staleness: a done answer is kept 24 h; after that the key is free again (the refund's own CAS still caps the total).
 */
import { createHash } from 'node:crypto';
import { redis } from '../services/redis.service';
import { AppError } from '../middleware/error-handler';

const TTL_SECONDS = 24 * 60 * 60;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** The client key from the `Idempotency-Key` header, validated; undefined when absent. 400 when malformed. */
export function idempotencyKeyOf(header: string | undefined): string | undefined {
  if (header === undefined || header === '') return undefined;
  if (!KEY_RE.test(header))
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 8-128 of [A-Za-z0-9._:-]'
    );
  return header;
}

/** A stable, bounded op key derived from the client's (for DO money ops, which take their own key format). */
export function opKey(scope: string, key: string): string {
  return `${scope}:${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

export async function withIdempotencyKey<T>(
  scope: string,
  key: string | undefined,
  fn: () => Promise<T>,
  mayHaveExecuted: (err: unknown) => boolean,
  opts: { required?: boolean } = {}
): Promise<{ replayed: boolean; value: T }> {
  if (!key && opts.required)
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'This refund needs an Idempotency-Key header (one per refund attempt). Nothing was done.'
    );
  if (!key) return { replayed: false, value: await fn() };
  const client = redis.getClient();
  if (!client || !redis.isAvailable())
    throw new AppError(503, 'IDEMPOTENCY_UNAVAILABLE', 'Try again shortly; nothing was done');
  const k = `idem:${opKey(scope, key)}`;
  const claimed = await client.set(k, 'pending', 'EX', TTL_SECONDS, 'NX');
  if (claimed !== 'OK') {
    const v = await client.get(k);
    if (v && v !== 'pending') return { replayed: true, value: (JSON.parse(v) as { done: T }).done };
    throw new AppError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this Idempotency-Key is still running or may already have gone through. Check before trying again.'
    );
  }
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    if (!mayHaveExecuted(err)) await client.del(k).catch(() => undefined);
    throw err;
  }
  await client.set(k, JSON.stringify({ done: value }), 'EX', TTL_SECONDS).catch(() => undefined);
  return { replayed: false, value };
}
