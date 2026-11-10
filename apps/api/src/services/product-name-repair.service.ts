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

export async function repairProductNames(
  storeId: string,
  opts: { apply: boolean }
): Promise<{ storeId: string; apply: boolean; scanned: number; items: NameRepairItem[] }> {
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

  if (opts.apply && items.length > 0) {
    const w = await storeWriter(storeId);
    for (const item of items) {
      const row = rows.find(r => r.id === item.id)!;
      const sources: Sources = { ...((row.aiFieldSources as Sources | null) ?? {}) };
      if (item.problem === 'swapped') {
        sources.nameAr = 'human';
        sources.name = 'ai';
      } else {
        sources.nameAr = 'human';
        delete sources.name;
      }
      await w.product.update({
        where: { id: item.id, storeId },
        data: { name: item.after.name, nameAr: item.after.nameAr, aiFieldSources: sources },
      });
      if (item.problem !== 'swapped') {
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
  }
  return { storeId, apply: opts.apply, scanned: rows.length, items };
}
