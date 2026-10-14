/**
 * Client-side CSV builder that reuses the platform's ONE canonical field
 * escaper (`csvField` in @ebda/shared), which is both RFC-4180-correct AND
 * formula-injection-safe (prefixes a cell leading with `= + - @`/tab/CR with a
 * quote so a crafted customer field can't execute as a spreadsheet formula).
 * Client exporters previously hand-rolled quote-only escaping, which does NOT
 * stop formula injection. Use `toCsv` instead of joining rows by hand.
 */
import { csvField } from '@ebda/shared';

export function toCsv(rows: readonly unknown[][]): string {
  return rows
    .map(row =>
      row.map(cell => csvField(cell as string | number | null | undefined | Date)).join(',')
    )
    .join('\n');
}
