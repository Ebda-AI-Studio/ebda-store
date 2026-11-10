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
import ts from 'typescript';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { parseSource, findAll, nameOf } from './helpers/ts-ast';

const PAGE_PATH = join(
  process.cwd(),
  'apps/admin/src/app/stores/[id]/customers/[customerKey]/page.tsx'
);

describe('customer order-history table — refund column is not a mobile badge', () => {
  // AST: each column is the object literal that carries `header: t('<key>')`, so its
  // `mobileBadge` is read off that literal's own property. (A text slice between two headers
  // also swallowed comments and a neighbouring column's literal.)
  const sf = parseSource(PAGE_PATH);
  const column = (key: string) => {
    const found = findAll(
      sf,
      (n): n is ts.ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(n) &&
        n.properties.some(
          p =>
            ts.isPropertyAssignment(p) &&
            nameOf(p) === 'header' &&
            p.initializer.getText() === `t('${key}')`
        )
    );
    expect(found, `column ${key}`).toHaveLength(1);
    return found[0];
  };
  const mobileBadge = (col: ts.ObjectLiteralExpression) =>
    col.properties.some(
      p =>
        ts.isPropertyAssignment(p) &&
        nameOf(p) === 'mobileBadge' &&
        p.initializer.kind === ts.SyntaxKind.TrueKeyword
    );

  it('colStatus stays a mobileBadge (the status pill belongs in the title row)', () => {
    expect(mobileBadge(column('colStatus'))).toBe(true);
  });

  it('colPayment (carries the refund amount/provider/date/reason text) is NOT a mobileBadge', () => {
    expect(mobileBadge(column('colPayment'))).toBe(false);
  });
});
