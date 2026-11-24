/**
 * Retention of consent evidence (Ruling NZ-N27B), driven by the `retention` block of each entry in
 * packages/cf-schema/erasure-classification.json (so a newly classified table needs no code change):
 *   - `nullColumns` older than `nullAfterMonths` are set to NULL (ip + user agent after 12 months: kept only as long as a dispute
 *     about who accepted is realistic; the acceptance fact stays);
 *   - the whole row is deleted once it is older than `deleteAfterYears` (RETENTION_YEARS = 7, config/retention.ts).
 * Idempotent: a second run finds nothing to do. Age is the table's own timestamp column (epoch ms in D1).
 */
import classification from '../../../../packages/cf-schema/erasure-classification.json';
import { RETENTION_YEARS } from '../config/retention';
import { d1Run } from './platform/billing-d1';

type Retention = {
  ageColumn: string;
  nullColumns?: string[];
  nullAfterMonths?: number;
  deleteAfterYears?: number;
};
type Entry = { db: 'store-do' | 'd1'; retention?: Retention };
const ENTRIES = classification as unknown as Record<string, Entry>;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** table -> retention rule, D1 only. */
// pq-allow(unused-export): a test seam, tests/unit/legal-evidence-retention.test.ts pins the plan read from the classification
export function legalEvidenceRetentionPlan(): Record<string, Retention> {
  const plan: Record<string, Retention> = {};
  for (const [key, e] of Object.entries(ENTRIES))
    if (e.db === 'd1' && e.retention) plan[key.split(':')[1]] = e.retention;
  return plan;
}

/**
 * `months` calendar months before `now`, the day clamped to the LAST day of the target month. `setUTCMonth` alone overflows
 * (31 Mar - 1 month = "31 Feb" = 3 Mar; 29 Feb - 12 months = "29 Feb" of a common year = 1 Mar), which moves the cutoff LATER and
 * would delete or NULL rows up to a few days younger than the retention window.
 */
// pq-allow(unused-export): a test seam, the clamp cases (31 Mar - 1 month, 29 Feb - 12 months) are pinned on it directly
export const monthsAgo = (now: number, months: number): number => {
  const d = new Date(now);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
};
// pq-allow(unused-export): a test seam, the 7 year cutoff is pinned on it directly
export const yearsAgo = (now: number, years: number): number => monthsAgo(now, years * 12);

interface RetentionResult {
  nulled: Record<string, number>;
  deleted: Record<string, number>;
}

export async function runLegalEvidenceRetention(
  now: number = Date.now(),
  run: (sql: string, ...params: unknown[]) => Promise<number> = d1Run
): Promise<RetentionResult> {
  const result: RetentionResult = { nulled: {}, deleted: {} };
  for (const [table, r] of Object.entries(legalEvidenceRetentionPlan())) {
    if (r.nullColumns?.length && r.nullAfterMonths) {
      const sets = r.nullColumns.map(c => `${ident(c)} = NULL`).join(', ');
      const anySet = r.nullColumns.map(c => `${ident(c)} IS NOT NULL`).join(' OR ');
      result.nulled[table] = await run(
        `UPDATE ${ident(table)} SET ${sets} WHERE ${ident(r.ageColumn)} < ?1 AND (${anySet})`,
        monthsAgo(now, r.nullAfterMonths)
      );
    }
    if (r.deleteAfterYears) {
      // the ruling's number is RETENTION_YEARS; a classification that asks for less than the law's floor is refused, not obeyed
      const years = Math.max(r.deleteAfterYears, RETENTION_YEARS);
      result.deleted[table] = await run(
        `DELETE FROM ${ident(table)} WHERE ${ident(r.ageColumn)} < ?1`,
        yearsAgo(now, years)
      );
    }
  }
  return result;
}
