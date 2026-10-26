import { z } from 'zod/v3';

/**
 * Size charts (B0 Task 9): one store-owned table (columns × rows of short text cells), linked to a
 * product or a category. The PDP shows the product's chart, else its category's, else nothing.
 */
export const SIZE_CHART_MAX_COLUMNS = 10;
export const SIZE_CHART_MAX_ROWS = 30;
export const SIZE_CHART_CELL_MAX = 24;

const cell = z.string().trim().max(SIZE_CHART_CELL_MAX);

export const sizeChartSchema = z
  .object({
    name: z.string().trim().max(60).default(''),
    nameAr: z.string().trim().max(60).default(''),
    unit: z.enum(['cm', 'in']).default('cm'),
    columns: z
      .array(z.object({ label: cell.default(''), labelAr: cell.default('') }))
      .min(2)
      .max(SIZE_CHART_MAX_COLUMNS),
    rows: z.array(z.array(cell)).min(1).max(SIZE_CHART_MAX_ROWS),
    note: z.string().trim().max(300).default(''),
    noteAr: z.string().trim().max(300).default(''),
  })
  .refine(c => c.name || c.nameAr, { message: 'Name needed', path: ['name'] })
  .refine(c => c.rows.every(r => r.length === c.columns.length), {
    message: 'Every row needs one cell per column',
    path: ['rows'],
  });

export type SizeChart = z.infer<typeof sizeChartSchema>;
export type SizeChartUnit = SizeChart['unit'];

/** What the storefront receives: a stored chart plus its id. */
export type PublicSizeChart = SizeChart & { id: string };

type Lang = 'ar' | 'en';

/** Active-language text with cross-language fallback, never blank when either side is set. */
function pick(en: string, ar: string, lang: Lang): string {
  return lang === 'ar' ? ar || en : en || ar;
}

export function sizeChartName(c: Pick<SizeChart, 'name' | 'nameAr'>, lang: Lang): string {
  return pick(c.name, c.nameAr, lang);
}

export function sizeChartColumnLabel(col: SizeChart['columns'][number], lang: Lang): string {
  return pick(col.label, col.labelAr, lang);
}

export function sizeChartNote(c: Pick<SizeChart, 'note' | 'noteAr'>, lang: Lang): string {
  return pick(c.note, c.noteAr, lang);
}

/**
 * A stored row (DB JSON) → a valid chart, or null when absent or malformed. The PDP and
 * `/size-guide` read through this, so a bad row hides the guide instead of breaking the page.
 */
export function toPublicSizeChart(raw: unknown): PublicSizeChart | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== 'string' || !id) return null;
  const parsed = sizeChartSchema.safeParse(raw);
  return parsed.success ? { id, ...parsed.data } : null;
}
