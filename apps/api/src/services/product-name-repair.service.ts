import { storeDb, storeWriter } from '../lib/repo-factory';
import { sendEventAfterCommit } from '../lib/inngest/send-after-commit';
import { isArabicText, isLatinText, isNamePlaceholder } from '../lib/product-name-pair';

/**
 * One-time repair of product name pairs written before Ruling NAME-PAIR-1 (super-admin, per store, DRY-RUN by default):
 *   - `swapped`:      Arabic in `name` and English in `nameAr` (the onboarding autofill "translated" Arabic as English)
 *                     -> swap them; the Arabic was typed (human), the English is the AI's.
 *   - `arabic-in-en`: Arabic in `name`, no `nameAr` (the quick-create form) -> the text becomes `nameAr`, `name` keeps it
 *                     as the placeholder the autofill translates.
 *   - `placeholder`:  `name === nameAr` -> `name` is handed back to the autofill (its 'human' stamp removed).
 * Applying writes the pair + provenance and emits `product.upserted` (changedFields nameAr) so the autofill fills the
 * English name. Nothing else on the product is touched.
 */
export type NameProblem = 'swapped' | 'arabic-in-en' | 'placeholder';

export interface NameRepairItem {
  id: string;
  name: string;
  nameAr: string | null;
  problem: NameProblem;
  after: { name: string; nameAr: string };
}

type Sources = Record<string, string>;

export function diagnoseName(p: {
  name: string;
  nameAr: string | null;
}): { problem: NameProblem; name: string; nameAr: string } | null {
  if (isArabicText(p.name) && p.nameAr && isLatinText(p.nameAr))
    return { problem: 'swapped', name: p.nameAr, nameAr: p.name };
  if (isArabicText(p.name) && !p.nameAr?.trim())
    return { problem: 'arabic-in-en', name: p.name, nameAr: p.name };
  if (isNamePlaceholder(p)) return { problem: 'placeholder', name: p.name, nameAr: p.nameAr! };
  return null;
}

/**
 * An English name the merchant typed (Latin text stamped 'human') is never overwritten by the repair: only an EMPTY Arabic
 * name may still be filled next to it. Returns the pair to write, or null when the row must be left exactly as it is.
 */
export function protectHumanEnglish(
  row: { name: string; nameAr: string | null; aiFieldSources: unknown },
  item: NameRepairItem
): { name: string; nameAr: string } | null {
  const src = (row.aiFieldSources as Sources | null) ?? {};
  if (!(isLatinText(row.name) && src.name === 'human')) return item.after;
  if (row.nameAr?.trim()) return null;
  return { name: row.name, nameAr: item.after.nameAr };
}

export async function repairProductNames(
  storeId: string,
  opts: { apply: boolean; productIds?: string[] }
): Promise<{
  storeId: string;
  apply: boolean;
  scanned: number;
  items: NameRepairItem[];
  applied: string[];
  skipped: Array<{ id: string; reason: 'not-repairable' | 'merchant-english' }>;
}> {
  const rows = (await (
    await storeDb(storeId)
  ).product.findMany({
    where: { storeId, deletedAt: null },
    select: { id: true, name: true, nameAr: true, aiFieldSources: true },
  })) as Array<{ id: string; name: string; nameAr: string | null; aiFieldSources: unknown }>;

  const items: NameRepairItem[] = [];
  for (const row of rows) {
    const d = diagnoseName(row);
    if (!d) continue;
    items.push({
      id: row.id,
      name: row.name,
      nameAr: row.nameAr,
      problem: d.problem,
      after: { name: d.name, nameAr: d.nameAr },
    });
  }

  const applied: string[] = [];
  const skipped: Array<{ id: string; reason: 'not-repairable' | 'merchant-english' }> = [];
  if (opts.apply) {
    // Apply writes ONLY the products the operator named after reading the dry run (Ruling NAME-PAIR-1): never "everything
    // the scan found", which could include a product the merchant fixed by hand in between.
    const wanted = new Set(opts.productIds ?? []);
    for (const id of wanted)
      if (!items.some(i => i.id === id)) skipped.push({ id, reason: 'not-repairable' });
    const w = await storeWriter(storeId);
    for (const item of items) {
      if (!wanted.has(item.id)) continue;
      const row = rows.find(r => r.id === item.id)!;
      const pair = protectHumanEnglish(row, item);
      if (!pair) {
        skipped.push({ id: item.id, reason: 'merchant-english' });
        continue;
      }
      const prior = (row.aiFieldSources as Sources | null) ?? {};
      const sources: Sources = { ...prior };
      const keptEnglish = pair.name === row.name && isLatinText(row.name) && prior.name === 'human';
      if (keptEnglish) {
        sources.nameAr = 'human';
      } else if (item.problem === 'swapped') {
        sources.nameAr = 'human';
        // the English moving into `name` keeps the merchant's stamp when the merchant typed it (in the Arabic field)
        sources.name = prior.nameAr === 'human' ? 'human' : 'ai';
      } else {
        sources.nameAr = 'human';
        delete sources.name;
      }
      await w.product.update({
        where: { id: item.id, storeId },
        data: { name: pair.name, nameAr: pair.nameAr, aiFieldSources: sources },
      });
      applied.push(item.id);
      // product.upserted for every repaired row: the search index re-reads the names, and the autofill fills `name`
      // (placeholder) or refreshes the AI's English from the merchant's Arabic (swapped).
      await sendEventAfterCommit(
        'product.name-repair',
        {
          name: 'product.upserted' as any,
          data: { storeId, productId: item.id, op: 'update', changedFields: ['nameAr'] },
        },
        { ifUnhookable: 'send' }
      );
    }
  }
  return { storeId, apply: opts.apply, scanned: rows.length, items, applied, skipped };
}
