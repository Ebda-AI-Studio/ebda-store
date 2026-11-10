/**
 * issue 2235 (owner 2026-10-01, ruling AUI-1a) — dashboard revenue excludes
 * orders whose payment FAILED; unpaid COD (payment not failed) still counts.
 * The Customers KPI strip reads the same population (countsTowardSpend), so
 * every revenue read here must carry the same predicate, or the two pages
 * disagree again. Source-level sweep: each `status notIn [cancelled,
 * refunded, awaiting_payment_confirmation]` revenue filter must be paired with the failed-payment exclusion.
 * The one deliberate exception is `getRevenueByPaymentStatus`, which is a
 * breakdown BY payment status and must keep showing the failed bucket.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { join } from 'node:path';
import {
  code,
  enclosingFunctionName,
  leadingComments,
  nodesOf,
  parseFile,
  stringText,
} from './helpers/ast-query';
import { countsTowardSpend } from '@api/services/customer-aggregate.service';

const sf = parseFile(join(__dirname, '../../apps/api/src/services/analytics.service.ts'));
const BREAKDOWN = 'getRevenueByPaymentStatus';
const prop = (o: ts.ObjectLiteralExpression, name: string) =>
  o.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && code(p.name) === name
  );
/** Object literals `{ status: { notIn: [...NON_REVENUE_ORDER_STATUSES] }, ... }` = a Prisma revenue filter. */
const revenueFilters = () =>
  nodesOf(sf).filter(
    (n): n is ts.ObjectLiteralExpression =>
      ts.isObjectLiteralExpression(n) &&
      prop(n, 'status') !== undefined &&
      code(prop(n, 'status')!.initializer) === '{ notIn: [...NON_REVENUE_ORDER_STATUSES] }'
  );
/** SQL statements (template literals) with their `-- comments` removed and `${x}` replaced. */
const sqlTemplates = () =>
  nodesOf(sf)
    .filter(
      (n): n is ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral =>
        ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)
    )
    .map(n => (stringText(n, '?') ?? '').replace(/--.*$/gm, ''));

describe('revenue population excludes failed payments (issue 2235)', () => {
  it('every Prisma revenue filter outside the payment-status breakdown excludes failed', () => {
    const outside = revenueFilters().filter(o => enclosingFunctionName(o) !== BREAKDOWN);
    expect(outside.length).toBeGreaterThanOrEqual(4);
    for (const o of outside) {
      // the SAME where-object carries the sibling predicate
      expect(
        code(prop(o, 'paymentStatus')?.initializer ?? o),
        `revenue filter in ${enclosingFunctionName(o)}`
      ).toBe("{ not: 'failed' }");
    }
  });

  it('every raw-SQL revenue filter excludes failed', () => {
    const sql = sqlTemplates().filter(t =>
      /status NOT IN \('cancelled', 'refunded', 'awaiting_payment_confirmation'\)/.test(t)
    );
    expect(sql.length).toBe(2);
    for (const t of sql) {
      // ANDed directly after the status filter inside the same statement
      expect(t).toMatch(
        /status NOT IN \('cancelled', 'refunded', 'awaiting_payment_confirmation'\)\s+AND\s+(?:\w+\.)?payment_status <> 'failed'/
      );
    }
  });

  // PR 2335 audit P3: the payment-status breakdown keeps failed payments ON
  // PURPOSE; the decision is pinned so it cannot drift silently either way.
  it('the payment-status breakdown deliberately keeps failed payments, and says so', () => {
    const method = nodesOf(sf).find(
      (n): n is ts.MethodDeclaration => ts.isMethodDeclaration(n) && code(n.name) === BREAKDOWN
    )!;
    expect(method).toBeDefined();
    const filters = revenueFilters().filter(o => enclosingFunctionName(o) === BREAKDOWN);
    expect(filters.length).toBeGreaterThan(0);
    for (const o of filters) expect(prop(o, 'paymentStatus')).toBeUndefined();
    expect(leadingComments(method)).toMatch(
      /DELIBERATELY the full population, failed payments included/
    );
  });

  it('the Customers KPI uses the same population', () => {
    expect(countsTowardSpend('delivered', 'paid')).toBe(true);
    expect(countsTowardSpend('pending', 'unpaid')).toBe(true); // COD not yet collected
    expect(countsTowardSpend('pending', 'failed')).toBe(false);
    expect(countsTowardSpend('cancelled', 'paid')).toBe(false);
    expect(countsTowardSpend('refunded', 'refunded')).toBe(false);
  });
});
