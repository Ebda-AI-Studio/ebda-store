/**
 * Issue #1930 — DataTable renders every `mobileBadge: true` column inside a
 * `shrink-0` slot in the mobile card's title row (DataTable.tsx:165). That
 * slot cannot shrink below its content width, so the refund detail cell on
 * the customer order history (`Refunded · -{amount} via {provider} on
 * {date} · reason: ...`) overflowed the phone card once it was folded into
 * `colPayment` and `colPayment` was marked `mobileBadge: true` alongside
 * `colStatus` — two multi-line blocks wedged into the top-right corner.
 *
 * This is a static source scan (same pattern as the other grep-based
 * standing-rule tests in this suite, e.g.
 * mass-assignment-prohibited-fields.test.ts) rather than a full render test,
 * because the page pulls in auth/store context that a render test would
 * have to stub out just to reach a column-definition object literal — the
 * defect is entirely in that literal's shape.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const PAGE_PATH = join(
  process.cwd(),
  'apps/admin/src/app/stores/[id]/customers/[customerKey]/page.tsx'
);

describe('customer order-history table — refund column is not a mobile badge', () => {
  const source = readFileSync(PAGE_PATH, 'utf8');

  it('colStatus stays a mobileBadge (the status pill belongs in the title row)', () => {
    const statusColumn = source.slice(
      source.indexOf("header: t('colStatus')"),
      source.indexOf("header: t('colPayment')")
    );
    expect(statusColumn).toMatch(/mobileBadge:\s*true/);
  });

  it('colPayment (carries the refund amount/provider/date/reason text) is NOT a mobileBadge', () => {
    const paymentColumnStart = source.indexOf("header: t('colPayment')");
    expect(paymentColumnStart).toBeGreaterThan(-1);
    // Look only within this column's object literal, up to the next
    // top-level column boundary, so a LATER column's mobileBadge (if any)
    // can never make this assertion pass for the wrong reason.
    const nextColumnBoundary = source.indexOf('\n    {', paymentColumnStart + 1);
    const paymentColumn = source.slice(paymentColumnStart, nextColumnBoundary);
    expect(paymentColumn).not.toMatch(/mobileBadge:\s*true/);
  });
});
