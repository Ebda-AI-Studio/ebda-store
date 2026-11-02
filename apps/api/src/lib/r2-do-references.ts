/**
 * The R2 keys referenced from the rows of ONE store that lives on its Durable Object (Ruling CF-JOBS-4B, CF-R2-REF-1). A DO store's
 * Postgres rows are sealed and stale, so "is this image still used" for such a store must be answered by its DO (`r2References`),
 * one page at a time per registered column set. Shared by the weekly sweep (every DO store) and the request-time per-URL check
 * (`r2-cleanup.service`, before an image is deleted).
 *
 * ANY failure (no DO client, a registry table the DO schema lacks) THROWS: with a partial reference set a live image would be called
 * an orphan. Both callers treat a throw as "keep the object". `toKey` maps a URL to its R2 key (or null for a foreign URL); it is
 * passed in so this module does not import the cleanup service (which imports this one).
 */
import { storeRepo } from './repo-factory';
import {
  columnsByTable,
  PLATFORM_R2_TABLES,
  urlsInColumnValue,
  urlsInString,
} from './r2-references';

/** `null` when the store is not on its Durable Object (its Postgres rows are the truth, read elsewhere). */
export async function collectDoStoreReferencedKeys(
  storeId: string,
  toKey: (url: string) => string | null,
  /** Stop reading as soon as this key is seen (the per-URL check); omit to collect every key (the sweep). */
  stopAtKey?: string
): Promise<Set<string> | null> {
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') return null;
  const money = repo.money;
  if (!money) throw new Error(`r2-references: no DO client for store ${storeId}`);
  const keys = new Set<string>();
  const add = (url: string) => {
    const key = toKey(url);
    if (key) keys.add(key);
  };
  const tables = [...columnsByTable()].filter(([t]) => !PLATFORM_R2_TABLES.includes(t));
  for (const [table, cols] of tables) {
    let after: string | undefined;
    do {
      const page = await money.r2References({
        table,
        columns: cols.map(c => c.column),
        after,
        limit: 1000,
      });
      if (page.missing)
        throw new Error(
          `r2-references: store ${storeId} has no ${table} with the registered columns`
        );
      for (const row of page.rows)
        for (const c of cols) {
          const v = row[c.column];
          if (v == null) continue;
          let value: unknown = v;
          if (c.kind === 'json') {
            try {
              value = JSON.parse(v);
            } catch {
              // unparseable JSON text: scan it as text (over-inclusive, which only keeps a file alive)
              for (const url of urlsInString(v)) add(url);
              continue;
            }
          }
          for (const url of urlsInColumnValue(c.kind, value)) add(url);
        }
      if (stopAtKey !== undefined && keys.has(stopAtKey)) return keys;
      after = page.last ?? undefined;
    } while (after);
  }
  return keys;
}
