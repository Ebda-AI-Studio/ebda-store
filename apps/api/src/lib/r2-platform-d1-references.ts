/**
 * NEON-ZERO-1 (N-10d): the R2 keys referenced from PLATFORM tables whose family has moved to D1. The Postgres scan
 * (`isR2UrlReferenced`, `collectReferencedR2Keys`) reads those tables in Postgres, where they are stale after the cutover:
 * a proof screenshot or a platform-branding image that only the D1 row still names would read as an orphan and be deleted.
 * ANY failure THROWS (the callers keep the object on a throw, the safe direction).
 */
import { columnsByTable, PLATFORM_R2_TABLES, urlsInColumnValue } from './r2-references';
import { platformFamilyOnD1, type PlatformFamily } from '../services/platform/cutover';

/** Registry platform table -> the family that moves it. `stores` / `users` are not in a family yet (identity / directory). */
const TABLE_FAMILY: Readonly<Record<string, PlatformFamily>> = {
  system_settings: 'platform',
  manual_payment_claims: 'payments',
};
const PAGE = 500;

export async function platformD1ReferencedKeys(
  toKey: (url: string) => string | null,
  stopAtKey?: string
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const [table, cols] of columnsByTable()) {
    const family = TABLE_FAMILY[table];
    if (!family || !PLATFORM_R2_TABLES.includes(table) || !(await platformFamilyOnD1(family)))
      continue;
    const { d1All } = await import('../services/platform/billing-d1.js');
    let after = '';
    for (;;) {
      const names = cols.map(c => `"${c.column}"`).join(', ');
      const rows = await d1All<Record<string, unknown> & { id: string }>(
        `SELECT id, ${names} FROM "${table}" WHERE id > ?1 ORDER BY id LIMIT ?2`,
        after,
        PAGE
      );
      for (const r of rows)
        for (const c of cols) {
          let v: unknown = r[c.column];
          if (v == null) continue;
          if (c.kind === 'json' && typeof v === 'string') {
            try {
              v = JSON.parse(v);
            } catch {
              /* unparseable: scanned as text below */
            }
          }
          const kind = c.kind === 'json' && typeof v === 'string' ? 'text' : c.kind;
          for (const url of urlsInColumnValue(kind, v)) {
            const key = toKey(url);
            if (key) keys.add(key);
          }
        }
      if (stopAtKey !== undefined && keys.has(stopAtKey)) return keys;
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1].id;
    }
  }
  return keys;
}
