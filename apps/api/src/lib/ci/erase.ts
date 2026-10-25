/**
 * Customer erasure / export of Customer Intelligence rows, SCOPED to what the requester owns.
 *
 * A buyer key is a hash of a phone number someone typed at checkout, so it is not proof of identity:
 * another person (or another store's customer) can share it. Therefore:
 *  - export and the default erase touch only rows whose `orderId` is one of the account's own orders AND
 *    whose `storeId` is the store of the request (`eraseCiForOrders`, `exportCiForOrders`);
 *  - a buyer-key erase (`eraseCiBuyerInStore`) is only for a phone the account PROVED it holds
 *    (`phoneOnOwnOrder`, Ruling WA-CONSENT-1), and only inside THE STORE that proof was made in: a
 *    single-store proof never reaches another store's rows.
 * Both write tombstones FIRST (keyed by order, or by store + buyer), so an event still in flight (queue
 * retry, DLQ replay) cannot re-create the data (lib/ci/sink.ts, lib/ci/replay.ts check them). Parked
 * dead letters (`dlq/`) for the scope are deleted too.
 *
 * Two modes: 'index' follows the buyer index (fast, first pass); 'prefix' lists the store's whole
 * partition prefix and matches by order id / key regardless of the index (the second pass, which also
 * catches a row whose index entry was lost to a race with the sink, and rows under a different key).
 */
import { gunzipText, gzipText } from '../../cf/erasure/surfaces';
import {
  ciBuyerIndexKey,
  ciBuyerTombstoneKey,
  ciOrderTombstoneKey,
  ciStorePartitionsPrefix,
} from './layout';

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
export type EraseMode = 'index' | 'prefix';
type Row = { storeId?: string; orderId?: string; buyerKey?: string | null };
type Match = (row: Row) => boolean;

const ownOrders = (s: CiOrderScope): Match => {
  const ids = new Set(s.orderIds);
  return r => r.storeId === s.storeId && !!r.orderId && ids.has(r.orderId);
};

async function listAll(ci: CiBucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await ci.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

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
  const match = ownOrders(s);
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const key of new Set(s.buyerKeys)) {
    for (const p of await partitionsOf(ci, key)) {
      if (!p.includes(`store=${s.storeId}/`) || seen.has(p)) continue;
      seen.add(p);
      for (const line of await rows(ci, p)) {
        const row = JSON.parse(line) as Row;
        if (match(row)) out.push(row);
      }
    }
  }
  return out;
}

/** Rewrites a partition keeping the lines `keep` accepts, by compare-and-set so a concurrent erase cannot restore removed rows. */
async function rewritePartition(ci: CiBucket, partition: string, keep: (line: string) => boolean) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const o = await ci.get(partition);
    // A partition the index names but that is not (yet) there may still be on its way from the sink:
    // report it as missing so its index entry is KEPT, never dropped.
    if (!o) return { removed: 0, missing: true, held: new Set<string>() };
    const lines = (await gunzipText(await o.arrayBuffer())).split('\n').filter(Boolean);
    const kept = lines.filter(keep);
    const result = {
      removed: lines.length - kept.length,
      missing: false,
      held: new Set(
        kept.flatMap(l =>
          (JSON.parse(l) as Row).buyerKey ? [(JSON.parse(l) as Row).buyerKey!] : []
        )
      ),
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

/**
 * Removes partitions from a buyer's index entry by compare-and-set. The entry is REWRITTEN (possibly with
 * no partitions), never deleted: a delete cannot be conditional, and a concurrent sink append would be lost.
 */
async function dropFromIndex(ci: CiBucket, buyerKey: string, drop: string[]): Promise<void> {
  if (drop.length === 0) return;
  const key = ciBuyerIndexKey(buyerKey);
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await ci.get(key);
    if (!cur) return;
    const all = (JSON.parse(await cur.text()).partitions as string[]) ?? [];
    const left = all.filter(p => !drop.includes(p));
    if (left.length === all.length) return;
    const opts = cur.etag ? { onlyIf: { etagMatches: cur.etag } } : undefined;
    if (await ci.put(key, JSON.stringify({ partitions: left }), opts)) return;
  }
  throw new Error(`buyer index contention while erasing: ${key}`);
}

/** Parked dead letters (`dlq/`) whose envelope is in scope are deleted (they hold buyerKey + orderId). */
async function sweepDlq(ci: CiBucket, match: Match): Promise<number> {
  let n = 0;
  for (const k of await listAll(ci, 'dlq/')) {
    const o = await ci.get(k);
    if (!o) continue;
    let body: Row | undefined;
    try {
      body = (JSON.parse(await o.text()) as { body?: Row }).body;
    } catch {
      continue; // unreadable: leave it, it will expire; it cannot be replayed either
    }
    if (body && match(body)) {
      await ci.delete(k);
      n++;
    }
  }
  return n;
}

async function eraseRows(
  ci: CiBucket,
  storeId: string,
  indexKeys: string[],
  match: Match,
  mode: EraseMode
): Promise<{ erased: number; remaining: number }> {
  const parts =
    mode === 'prefix'
      ? await listAll(ci, ciStorePartitionsPrefix(storeId))
      : [
          ...new Set(
            (await Promise.all(indexKeys.map(k => partitionsOf(ci, k))))
              .flat()
              .filter(p => p.includes(`store=${storeId}/`))
          ),
        ];
  let erased = 0;
  const read = new Map<string, { held: Set<string>; missing: boolean }>();
  for (const p of parts) {
    const r = await rewritePartition(ci, p, l => !match(JSON.parse(l) as Row));
    erased += r.removed;
    read.set(p, r);
  }
  for (const key of new Set(indexKeys)) {
    const drop = [...read].filter(([, r]) => !r.missing && !r.held.has(key)).map(([p]) => p);
    await dropFromIndex(ci, key, drop);
  }
  erased += await sweepDlq(ci, match);
  let remaining = 0;
  for (const p of parts)
    for (const l of await rows(ci, p)) if (match(JSON.parse(l) as Row)) remaining++;
  return { erased, remaining };
}

/** Removes only the account's own orders' rows in this store; every other row survives, even under the same buyer key. */
export async function eraseCiForOrders(ci: CiBucket, s: CiOrderScope, mode: EraseMode = 'index') {
  for (const id of new Set(s.orderIds)) await ci.put(ciOrderTombstoneKey(id), '1');
  return eraseRows(ci, s.storeId, s.buyerKeys, ownOrders(s), mode);
}

/** A buyer-key erase for a phone the account proved it holds, IN THAT STORE only. Tombstone first. */
export async function eraseCiBuyerInStore(
  ci: CiBucket,
  p: { storeId: string; buyerKeys: string[] },
  mode: EraseMode = 'index'
) {
  const keys = new Set(p.buyerKeys);
  for (const k of keys) await ci.put(ciBuyerTombstoneKey(p.storeId, k), '1');
  return eraseRows(
    ci,
    p.storeId,
    [...keys],
    r => r.storeId === p.storeId && !!r.buyerKey && keys.has(r.buyerKey),
    mode
  );
}
