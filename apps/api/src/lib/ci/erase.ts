/**
 * Customer erasure / export of Customer Intelligence rows, SCOPED to what the requester owns.
 *
 * A buyer key is a hash of a phone number someone typed at checkout, so it is not proof of identity:
 * another person (or another store's customer) can share it. Therefore:
 *  - export and the default erase touch only rows whose `orderId` is one of the account's own orders AND
 *    whose `storeId` is the store of the request (`eraseCiForOrders`, `exportCiForOrders`);
 *  - a buyer-key-WIDE erase (every store, every order under that key) is only for a phone the account
 *    PROVED it holds (`phoneOnOwnOrder`, Ruling WA-CONSENT-1), and is `eraseCiBuyerKey`.
 * Both write tombstones FIRST, so an event still in flight (queue retry, DLQ replay) cannot re-create
 * the data after the erase (lib/ci/sink.ts checks them).
 */
import { ciSurface, gunzipText, gzipText } from '../../cf/erasure/surfaces';
import { ciBuyerIndexKey, ciBuyerTombstoneKey, ciOrderTombstoneKey } from './layout';

export interface CiBucket {
  get(key: string): Promise<{
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    etag?: string;
  } | null>;
  put(
    key: string,
    value: string | Uint8Array,
    opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }
  ): Promise<unknown | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface CiOrderScope {
  storeId: string;
  orderIds: string[];
  buyerKeys: string[];
}

const inScope = (row: { storeId?: string; orderId?: string }, s: CiOrderScope, ids: Set<string>) =>
  row.storeId === s.storeId && !!row.orderId && ids.has(row.orderId);

async function partitionsOf(ci: CiBucket, buyerKey: string): Promise<string[]> {
  const idx = await ci.get(ciBuyerIndexKey(buyerKey));
  return idx ? ((JSON.parse(await idx.text()).partitions as string[]) ?? []) : [];
}

async function rows(ci: CiBucket, partition: string): Promise<string[]> {
  const o = await ci.get(partition);
  return o ? (await gunzipText(await o.arrayBuffer())).split('\n').filter(Boolean) : [];
}

/** Rows (parsed) of the account's own orders in this store. */
export async function exportCiForOrders(ci: CiBucket, s: CiOrderScope): Promise<unknown[]> {
  const ids = new Set(s.orderIds);
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const key of new Set(s.buyerKeys)) {
    for (const p of await partitionsOf(ci, key)) {
      if (!p.includes(`store=${s.storeId}/`) || seen.has(p)) continue;
      seen.add(p);
      for (const line of await rows(ci, p)) {
        const row = JSON.parse(line) as { storeId?: string; orderId?: string };
        if (inScope(row, s, ids)) out.push(row);
      }
    }
  }
  return out;
}

/** Removes only the account's own orders' rows (this store); keeps every other row, even under the same buyer key. */
export async function eraseCiForOrders(
  ci: CiBucket,
  s: CiOrderScope
): Promise<{ erased: number; remaining: number }> {
  const ids = new Set(s.orderIds);
  // Tombstones first: an in-flight event for these orders is dropped from now on.
  for (const id of ids) await ci.put(ciOrderTombstoneKey(id), '1');
  let erased = 0;
  let remaining = 0;
  for (const key of new Set(s.buyerKeys)) {
    const parts = (await partitionsOf(ci, key)).filter(p => p.includes(`store=${s.storeId}/`));
    const stillHeld = new Set<string>();
    for (const p of parts) {
      const r = await rewritePartition(ci, p, line => !inScope(JSON.parse(line), s, ids));
      erased += r.removed;
      if (r.keptForKey(key)) stillHeld.add(p);
    }
    await dropFromIndex(
      ci,
      key,
      parts.filter(p => !stillHeld.has(p))
    );
    for (const p of parts)
      remaining += (await rows(ci, p)).filter(l => inScope(JSON.parse(l), s, ids)).length;
  }
  return { erased, remaining };
}

/** Rewrites a partition keeping the lines `keep` accepts, by compare-and-set so a concurrent erase cannot restore removed rows. */
async function rewritePartition(ci: CiBucket, partition: string, keep: (line: string) => boolean) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const o = await ci.get(partition);
    if (!o) return { removed: 0, keptForKey: () => false };
    const lines = (await gunzipText(await o.arrayBuffer())).split('\n').filter(Boolean);
    const kept = lines.filter(keep);
    const result = {
      removed: lines.length - kept.length,
      keptForKey: (k: string) =>
        kept.some(l => (JSON.parse(l) as { buyerKey?: string }).buyerKey === k),
    };
    if (kept.length === lines.length) return result;
    if (kept.length === 0) {
      await ci.delete(partition); // partitions are write-once, nothing is appended after creation
      return result;
    }
    const opts = o.etag ? { onlyIf: { etagMatches: o.etag } } : undefined;
    if (await ci.put(partition, await gzipText(kept.join('\n') + '\n'), opts)) return result;
  }
  throw new Error(`partition contention while erasing: ${partition}`);
}

/** Compare-and-set removal of partitions from a buyer's index entry; the entry goes when it is empty. */
async function dropFromIndex(ci: CiBucket, buyerKey: string, drop: string[]): Promise<void> {
  if (drop.length === 0) return;
  const key = ciBuyerIndexKey(buyerKey);
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await ci.get(key);
    if (!cur) return;
    const left = ((JSON.parse(await cur.text()).partitions as string[]) ?? []).filter(
      p => !drop.includes(p)
    );
    if (left.length === 0) return void (await ci.delete(key));
    if (
      await ci.put(
        key,
        JSON.stringify({ partitions: left }),
        cur.etag ? { onlyIf: { etagMatches: cur.etag } } : undefined
      )
    )
      return;
  }
  throw new Error(`buyer index contention while erasing: ${key}`);
}

/** A buyer-key-wide erase: ONLY for a phone the account proved it holds. Tombstone first. */
export async function eraseCiBuyerKey(ci: CiBucket, buyerKey: string, requestId: string) {
  await ci.put(ciBuyerTombstoneKey(buyerKey), '1');
  return ciSurface(ci as never).eraseSubject({ kind: 'customer', requestId, buyerKey });
}
