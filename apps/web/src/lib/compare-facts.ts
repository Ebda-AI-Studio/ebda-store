import { factText, type ProductFact } from '@ebda/shared';

/** Row identity: (EN name trimmed + lowercased, AR name trimmed). Rows merge only when BOTH match. */
export const factRowId = (f: ProductFact) => `${f.key.trim().toLowerCase()}\u0000${f.keyAr.trim()}`;

/** One row per distinct fact name pair across the products, first-seen order. */
export function compareFactRows(
  products: Array<{ id: string; facts?: ProductFact[] }>,
  lang: 'ar' | 'en'
): Array<{ id: string; label: string; values: Record<string, string> }> {
  const rows: Array<{ id: string; label: string; values: Record<string, string> }> = [];
  for (const p of products) {
    for (const f of p.facts ?? []) {
      const id = factRowId(f);
      let row = rows.find(r => r.id === id);
      if (!row) {
        row = { id, label: factText(f, lang).key, values: {} };
        rows.push(row);
      }
      row.values[p.id] ??= factText(f, lang).value;
    }
  }
  return rows;
}
