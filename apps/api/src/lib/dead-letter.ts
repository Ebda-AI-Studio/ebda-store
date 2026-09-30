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
